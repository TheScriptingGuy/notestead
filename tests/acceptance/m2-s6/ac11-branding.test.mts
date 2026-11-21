// M2-AC11 at file level (docs/test-plans/M2-S6.md, U-AC11-01 to 04): the real `web-build overlay` on fixture F2 (upstream's
// public/ at the pin plus synthetic webpack outputs, M1-S2) leaves every page with our title and description and every icon
// reference pointing at a file whose bytes are our overlay's. U-AC11-04 is the NEG: the same checkers on the un-overlaid F2
// report upstream's branding, so the checkers can see it. The expectations are constants (tests/support/branding.ts), never read
// from overlay.json. The feature landed in M1-S2: the planner expects 4/4 on arrival.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertExitZero, describeRun, removeDir, repoRoot } from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';
import { attempt, materialize, readTree, settled, upstreamPublicBundle, webBuild } from '../support/webBundle.mts';
import type { Attempt, Tree } from '../support/webBundle.mts';
import {
	htmlBrandingProblems, iconRefs, manifestBrandingProblems, manifestIconRefs, metaContents, notAffiliated, productName, titleOf,
} from '../../support/branding.ts';
import type { BrandedPage } from '../../support/branding.ts';

const pages: { page: BrandedPage; file: string }[] = [
	{ page: 'index', file: 'index.html' },
	{ page: 'closed', file: 'closed.html' },
	{ page: 'just-one-client', file: 'just-one-client.html' },
];

const overlayIconsDir = join(repoRoot, 'packages', 'web-build', 'overlay', 'icons');
const overlayIcons = (): Map<string, Buffer> => new Map(readdirSync(overlayIconsDir).sort().map(name => [`icons/${name}`, readFileSync(join(overlayIconsDir, name))]));

const textOf = (tree: Tree, path: string): string => {
	const content = tree.get(path);
	assert.ok(content, `${path} is not in the bundle (files: ${[...tree.keys()].slice(0, 12).join(', ')} …)`);
	return content.toString('utf8');
};

// Every icon reference of the three pages and of the manifest, resolved to a path in the bundle (the bundle root is the URL root).
const iconPaths = (tree: Tree): { from: string; ref: string; path: string }[] => {
	const found: { from: string; ref: string; path: string }[] = [];
	for (const { file } of pages) {
		for (const { href } of iconRefs(textOf(tree, file))) found.push({ from: file, ref: href, path: new URL(href, `http://bundle.test/${file}`).pathname.slice(1) });
	}
	for (const icon of manifestIconRefs(JSON.parse(textOf(tree, 'manifest.json')))) {
		found.push({ from: 'manifest.json', ref: icon.src, path: posix.normalize(new URL(icon.src, 'http://bundle.test/manifest.json').pathname.slice(1)) });
	}
	return found;
};

describe('M2-AC11 the overlay output carries our branding (file level)', () => {
	const temps: string[] = [];
	let setup: Attempt<{ overlay: RunResult; overlaid: Tree; upstream: Tree }> | null = null;

	before(() => {
		setup = attempt(() => {
			const upstream = upstreamPublicBundle();
			const dir = materialize('m2s6-ac11-overlaid', upstream);
			temps.push(dir);
			const overlay = webBuild('U-AC11-overlay-F2', 'overlay', [dir]);
			return { overlay, overlaid: overlay.code === 0 ? readTree(dir) : new Map<string, Buffer>(), upstream };
		});
	});

	after(() => temps.forEach(removeDir));

	const bundles = (): { overlaid: Tree; upstream: Tree } => {
		const { overlay, overlaid, upstream } = settled(setup);
		assertExitZero(overlay);
		assert.ok(overlaid.size > 0, `the overlay produced no files. ${describeRun(overlay)}`);
		return { overlaid, upstream };
	};

	it('U-AC11-01 every page has exactly one title, with the product name and no Joplin outside it', () => {
		const { overlaid } = bundles();
		for (const { file } of pages) {
			const titles = titleOf(textOf(overlaid, file));
			assert.equal(titles.length, 1, `${file} must have exactly one <title>; found ${JSON.stringify(titles)}`);
			assert.ok(titles[0].includes(productName), `${file} title ${JSON.stringify(titles[0])} must contain ${JSON.stringify(productName)}`);
			assert.ok(!/joplin/i.test(titles[0].split(productName).join('').split('JOPLIN SAS').join('')), `${file} title ${JSON.stringify(titles[0])} says "Joplin" outside the product name`);
		}
	});

	it('U-AC11-02 every description names the product and the notice, no upstream description remains, og:image is an overlay icon', () => {
		const { overlaid, upstream } = bundles();
		const upstreamTexts = pages.flatMap(({ file }) => [...metaContents(textOf(upstream, file), 'description'), ...metaContents(textOf(upstream, file), 'og:description')]).filter(t => t !== '');
		const icons = overlayIcons();
		for (const { page, file } of pages) {
			const html = textOf(overlaid, file);
			const keys = page === 'index' ? ['description', 'og:description'] : ['description'];
			for (const key of keys) {
				const contents = metaContents(html, key);
				assert.ok(contents.length > 0, `${file} has no ${key} meta`);
				for (const content of contents) {
					assert.ok(content.includes(productName), `${file} ${key} ${JSON.stringify(content)} must name ${JSON.stringify(productName)}`);
					for (const pattern of notAffiliated) assert.match(content, pattern, `${file} ${key} must carry the not-affiliated notice`);
					assert.ok(!upstreamTexts.includes(content), `${file} ${key} is still upstream's text`);
				}
			}
			for (const text of upstreamTexts) assert.ok(!html.includes(text), `${file} still contains upstream description text ${JSON.stringify(text)}`);
		}
		const og = iconRefs(textOf(overlaid, 'index.html')).filter(r => r.rel === 'og:image');
		assert.ok(og.length > 0, 'index.html declares no og:image');
		for (const ref of og) {
			const path = new URL(ref.href, 'http://bundle.test/index.html').pathname.slice(1);
			assert.ok(icons.has(path), `og:image ${ref.href} (${path}) is not one of our overlay icons (${[...icons.keys()].join(', ')})`);
		}
	});

	it('U-AC11-03 every icon reference resolves to a file whose bytes are our overlay icon, and icons/ holds exactly our set', () => {
		const { overlaid } = bundles();
		const icons = overlayIcons();
		const refs = iconPaths(overlaid);
		assert.ok(refs.length >= pages.length + 5, `expected the pages' and the manifest's icon references, found ${refs.length}: ${JSON.stringify(refs)}`);
		for (const { from, ref, path } of refs) {
			const wanted = icons.get(path);
			assert.ok(wanted, `${from}: the icon ${ref} resolves to ${path}, which is not one of our overlay icons (${[...icons.keys()].join(', ')})`);
			assert.ok(overlaid.get(path)?.equals(wanted), `${from}: ${path} differs from packages/web-build/overlay/${path}`);
		}
		const served = [...overlaid.keys()].filter(p => p.startsWith('icons/')).sort();
		assert.deepEqual(served, [...icons.keys()].sort(), 'icons/ must hold exactly the overlay\'s icons');
		for (const [path, content] of icons) assert.ok(overlaid.get(path)?.equals(content), `${path} differs from the overlay's`);
	});

	it('U-AC11-04 NEG: the same checkers report upstream\'s branding on the un-overlaid bundle', () => {
		const { upstream } = bundles();
		const icons = overlayIcons();
		for (const { page, file } of pages) {
			const problems = htmlBrandingProblems(page, textOf(upstream, file));
			assert.ok(problems.length > 0, `${file}: the checkers found nothing wrong with upstream's page, so they cannot see its branding`);
		}
		const manifestProblems = manifestBrandingProblems(JSON.parse(textOf(upstream, 'manifest.json')));
		assert.ok(manifestProblems.length > 0, 'the checkers found nothing wrong with upstream\'s manifest');
		const refs = iconPaths(upstream);
		assert.ok(refs.length > 0, 'upstream\'s pages and manifest declare icons');
		const notOurs = refs.filter(({ path }) => !icons.get(path)?.equals(upstream.get(path) ?? Buffer.alloc(0)));
		assert.ok(notOurs.length > 0, 'U-AC11-03\'s comparison finds no upstream icon that differs from ours: it cannot tell them apart');
	});
});
