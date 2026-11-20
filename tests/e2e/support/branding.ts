// E2E helpers of the M2-S6 branding tests (docs/test-plans/M2-S6.md D5 to D7): the oracle (the commit the served bundle was built
// from, and our overlay icons at that commit), the checker that reads a served `web` container for branding, and the served-file
// scan. The same functions run against the image's own bundle (M2-AC11-01/02, expecting no problem) and against the un-overlaid
// bundle (M2-AC11-03, expecting upstream's branding to be reported): a checker that cannot see upstream's branding proves nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { request } from '../../contract/support/http.ts';
import {
	htmlBrandingProblems, iconRefs, manifestBrandingProblems, manifestIconRefs, upstreamHashHits,
} from '../../support/branding.ts';
import type { BrandedPage } from '../../support/branding.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { upstreamPublic } from './upstreamBranding.ts';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

// The commit of this repository the served bundle was built from (docs/test-plans/M2-S6.md I4, D6): the artifact's
// bundle-manifest.json `notestead.commit`. Unset or unreadable is a failure, never a skip.
export const servedBundleCommit = (env: Record<string, string | undefined> = process.env): string => {
	const dir = env.NOTESTEAD_WEB_ARTIFACT;
	if (!dir) throw new Error('M2-S6 needs NOTESTEAD_WEB_ARTIFACT (the artifact the web image was built from): its bundle-manifest.json names the commit our overlay icons and the source offer are checked against');
	let commit: unknown;
	try {
		commit = (JSON.parse(readFileSync(join(dir, 'bundle-manifest.json'), 'utf8')) as { notestead?: { commit?: unknown } }).notestead?.commit;
	} catch (error) {
		throw new Error(`M2-S6 needs NOTESTEAD_WEB_ARTIFACT (the artifact the web image was built from): ${dir}/bundle-manifest.json is unreadable (${(error as Error).message})`);
	}
	if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${dir}/bundle-manifest.json has no notestead.commit (40 hex digits): ${JSON.stringify(commit)}`);
	return commit;
};

const git = (args: string[]): Buffer => {
	const r = spawnSync('git', args, { cwd: findRepoRoot(), maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr?.toString().trim()}`);
	return r.stdout;
};

const overlayIconsPath = 'packages/web-build/overlay/icons';

// Our overlay's icons as they are at `commit`: name -> bytes (`git ls-tree` and `git show`).
export const overlayIconsAt = (commit: string): Map<string, Buffer> => {
	const names = git(['ls-tree', '--name-only', commit, `${overlayIconsPath}/`]).toString('utf8').split('\n').filter(n => n !== '').map(n => posix.basename(n));
	if (names.length === 0) throw new Error(`commit ${commit} has no ${overlayIconsPath}/: it is not a commit of this repository's history (a shallow clone?)`);
	return new Map(names.sort().map(name => [name, git(['show', `${commit}:${overlayIconsPath}/${name}`])]));
};

export interface Fetched { path: string; status: number; contentType: string; sha256: string; size: number; body: Buffer }

// A path of the container under test, through its published port, as Node (no Accept-Encoding, so the body is the file's).
export const fetchServed = async (port: number, path: string): Promise<Fetched> => {
	const res = await request({ port, path });
	return { path, status: res.status, contentType: String(res.headers['content-type'] ?? ''), sha256: sha256(res.body), size: res.body.length, body: res.body };
};

export interface BrandingTarget {
	port: number;
	origin: string;
	// the directory the container serves (a tree on disk): `unoverlaidDist.served` or `.unoverlaid`
	servedDir: string;
	// the overlay icons the served ones must equal
	ourIcons: Map<string, Buffer>;
}

const pageFiles: { page: BrandedPage; path: string }[] = [
	{ page: 'index', path: '/index.html' },
	{ page: 'closed', path: '/closed.html' },
	{ page: 'just-one-client', path: '/just-one-client.html' },
];

export interface BrandingReport {
	// <title> and description problems per page (tests/support/branding.ts)
	htmlProblems: string[];
	// manifest problems from the file the container serves
	manifestProblems: string[];
	// an icon reference that does not resolve to one of our overlay icons, byte for byte
	iconProblems: string[];
	// every icon reference that was fetched, for the annotation
	iconsChecked: string[];
	// files under the served icons/ and our icons that are not in the other
	iconSetProblems: string[];
}

// Reads the container's three pages and manifest over HTTP and every icon they reference. Problems are strings that name the
// page and the file; none means the branding is ours (M2-AC11), upstream's bundle yields problems in every list.
export const brandingReport = async (t: BrandingTarget): Promise<BrandingReport> => {
	const report: BrandingReport = { htmlProblems: [], manifestProblems: [], iconProblems: [], iconsChecked: [], iconSetProblems: [] };
	const refs: { from: string; fromUrl: string; href: string }[] = [];
	for (const { page, path } of pageFiles) {
		const res = await fetchServed(t.port, path);
		if (res.status !== 200) {
			report.htmlProblems.push(`${path}: HTTP ${res.status}`);
			continue;
		}
		const html = res.body.toString('utf8');
		report.htmlProblems.push(...htmlBrandingProblems(page, html));
		for (const ref of iconRefs(html)) refs.push({ from: path, fromUrl: `${t.origin}${path}`, href: ref.href });
	}
	const manifest = await fetchServed(t.port, '/manifest.json');
	if (manifest.status !== 200) {
		report.manifestProblems.push(`/manifest.json: HTTP ${manifest.status}`);
	} else {
		const json: unknown = JSON.parse(manifest.body.toString('utf8'));
		report.manifestProblems.push(...manifestBrandingProblems(json));
		for (const icon of manifestIconRefs(json)) refs.push({ from: '/manifest.json', fromUrl: `${t.origin}/manifest.json`, href: icon.src });
	}
	for (const { from, fromUrl, href } of refs) {
		const url = new URL(href, fromUrl);
		if (url.origin !== t.origin) {
			report.iconProblems.push(`${from}: the icon ${href} is on another origin (${url.origin})`);
			continue;
		}
		const res = await fetchServed(t.port, url.pathname);
		report.iconsChecked.push(`${from} -> ${url.pathname}`);
		const name = url.pathname.startsWith('/icons/') ? url.pathname.slice('/icons/'.length) : undefined;
		const ours = name === undefined ? undefined : t.ourIcons.get(name);
		if (res.status !== 200) report.iconProblems.push(`${from}: ${url.pathname} answers HTTP ${res.status}`);
		else if (!res.contentType.startsWith('image/')) report.iconProblems.push(`${from}: ${url.pathname} is served as ${JSON.stringify(res.contentType)}, not image/*`);
		else if (!ours) report.iconProblems.push(`${from}: ${url.pathname} is not one of our overlay icons (${[...t.ourIcons.keys()].join(', ')})`);
		else if (!ours.equals(res.body)) report.iconProblems.push(`${from}: ${url.pathname} (sha256 ${res.sha256.slice(0, 12)}...) differs from packages/web-build/overlay/icons/${name} (sha256 ${sha256(ours).slice(0, 12)}...)`);
	}
	const onDisk = filesUnder(join(t.servedDir, 'icons'));
	for (const name of onDisk) if (!t.ourIcons.has(name)) report.iconSetProblems.push(`the served icons/${name} is not one of our overlay icons`);
	for (const name of t.ourIcons.keys()) if (!onDisk.includes(name)) report.iconSetProblems.push(`our overlay icon ${name} is not served under icons/`);
	return report;
};

const filesUnder = (dir: string): string[] => {
	try {
		return readdirSync(dir).filter(n => lstatSync(join(dir, n)).isFile()).sort();
	} catch {
		return [];
	}
};

// Every regular file under `dir` as a URL path ("/a/b.js"), sorted.
export const servedPaths = (dir: string): string[] => {
	const out: string[] = [];
	const visit = (d: string, prefix: string): void => {
		for (const entry of readdirSync(d).sort()) {
			const p = join(d, entry);
			if (lstatSync(p).isDirectory()) visit(p, `${prefix}${entry}/`);
			else out.push(`${prefix}${entry}`);
		}
	};
	visit(dir, '/');
	return out;
};

export interface ScanResult {
	entries: { path: string; status: number; contentType: string; sha256: string }[];
	iconHits: { path: string; upstreamPath: string }[];
	screenshotHits: { path: string; upstreamPath: string }[];
	pngs: number;
	servedFiles: number;
}

const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// The served-file scan (D7): the union of the served tree, the same-origin paths the browser requested, and probes for upstream's
// own names, each fetched through the container and its body hashed whatever the status.
export const scanServed = async (port: number, servedDir: string, requestedUrls: string[], hashes: { icons: Map<string, string>; screenshots: Map<string, string> }): Promise<ScanResult> => {
	const paths = new Set<string>(servedPaths(servedDir));
	const servedFiles = paths.size;
	for (const url of requestedUrls) {
		try {
			const u = new URL(url);
			if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') paths.add(u.pathname);
		} catch {
			// not a URL (data:, blob:)
		}
	}
	for (const path of upstreamPublic().keys()) paths.add(`/${path}`);
	paths.add('/favicon.ico');
	paths.add('/apple-touch-icon.png');
	const entries: ScanResult['entries'] = [];
	let pngs = 0;
	for (const path of [...paths].filter(p => !p.startsWith('/joplin-server/')).sort()) {
		const res = await fetchServed(port, path);
		entries.push({ path, status: res.status, contentType: res.contentType, sha256: res.sha256 });
		if (res.body.subarray(0, 4).equals(pngMagic)) pngs++;
	}
	return {
		entries,
		iconHits: upstreamHashHits(entries, hashes.icons),
		screenshotHits: upstreamHashHits(entries, hashes.screenshots),
		pngs,
		servedFiles,
	};
};

// RU-2: upstream's service worker redirects /just-one-client.html to the app unless another tab of the context has the app open.
// So the app page is opened first and kept; these two pages are opened in second pages of the same context. Each is checked for its
// own URL (a redirect fails here, by name) and its upstream h1 before anything else.
export const staticPages = {
	closed: { path: '/closed.html', heading: /Closed externally/ },
	justOneClient: { path: '/just-one-client.html?no-retry=1', heading: /Only one copy of Joplin can be open at a time/ },
} as const;

export const openStaticPage = async (context: BrowserContext, origin: string, which: keyof typeof staticPages): Promise<Page> => {
	const { path, heading } = staticPages[which];
	const page = await context.newPage();
	try {
		await page.goto(origin + path);
		await expect(page, `${path} stays on its own URL (the service worker redirects it to the app unless the app is open in another tab)`).toHaveURL(origin + path);
		await expect(page.getByRole('heading', { level: 1, name: heading }), `${path}: its upstream heading`).toBeVisible();
	} catch (error) {
		await page.close();
		throw error;
	}
	return page;
};
