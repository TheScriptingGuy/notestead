// The un-overlaid bundle of M2-S6, reconstructed from the served one without a build (docs/test-plans/M2-S6.md D2):
//   1. `podman cp` of the stack's web container's /srv/www: the exact served tree
//   2. a copy of it without source.html, notestead-overlay.css, third-party-notices.txt and the whole icons/ directory
//   3. every file of upstream's public/ at the pin written over it (environment.js, index.html, closed.html,
//      just-one-client.html, manifest.json, icons/*, screenshots/*)
// The overlay never touches the webpack outputs (M1-S2 T55, T90), so this is what `yarn web` produces. The result is mounted
// into a container of the image under test; it holds upstream's files and lives under test-results/ only, never committed.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { podmanSync } from '../../stack/stack.ts';
import type { StackState } from '../../stack/stack.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { upstreamGitDir } from '../../acceptance/support/upstream.mts';
import { upstreamPublic } from './upstreamBranding.ts';

export interface UnoverlaidDirs { served: string; unoverlaid: string }

// What the overlay adds (the overlay's files that upstream's public/ does not have), removed in step 2.
const overlayAdded = ['source.html', 'notestead-overlay.css', 'third-party-notices.txt', 'icons'];

const walk = (dir: string): Map<string, Buffer> => {
	const files = new Map<string, Buffer>();
	const visit = (d: string): void => {
		for (const entry of readdirSync(d).sort()) {
			const p = join(d, entry);
			const stats = lstatSync(p);
			if (stats.isDirectory()) visit(p);
			else if (stats.isFile()) files.set(relative(dir, p).split(sep).join('/'), readFileSync(p));
			else throw new Error(`${p} is neither a regular file nor a directory`);
		}
	};
	visit(dir);
	return files;
};

// Modes 0644 and 0755 only: the container's user (65532) reads the bind mount through the "other" bits.
const normalizeModes = (dir: string): void => {
	chmodSync(dir, 0o755);
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (lstatSync(p).isDirectory()) normalizeModes(p);
		else chmodSync(p, 0o644);
	}
};

export const reconstructUnoverlaid = (stack: StackState, dir: string): UnoverlaidDirs => {
	const container = stack.containers.web;
	if (!container) throw new Error('the stack has no web container');
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const served = join(dir, 'served');
	const unoverlaid = join(dir, 'unoverlaid');
	podmanSync(['cp', `${container}:/srv/www`, served]);
	normalizeModes(served);
	cpSync(served, unoverlaid, { recursive: true });
	for (const name of overlayAdded) rmSync(join(unoverlaid, name), { recursive: true, force: true });
	for (const [path, content] of upstreamPublic()) {
		const target = join(unoverlaid, ...path.split('/'));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	normalizeModes(unoverlaid);
	return { served, unoverlaid };
};

const verifyBound = 120_000;

// D2 step 4: the problems with a reconstruction (empty: it is what it claims to be).
//   - every file that is not upstream's public/ is byte-identical to the served file, and every served file that is neither
//     overlay-added nor upstream's is still there
//   - every public/ file equals upstream's blob
//   - `web-build verify` exits non-zero and names all six icons/* and environment.js
export const checkUnoverlaid = (dirs: UnoverlaidDirs): string[] => {
	const problems: string[] = [];
	const served = walk(dirs.served);
	const unoverlaid = walk(dirs.unoverlaid);
	const upstream = upstreamPublic();
	for (const [path, content] of unoverlaid) {
		const up = upstream.get(path);
		if (up) {
			if (!up.equals(content)) problems.push(`${path} differs from upstream's blob at the pin`);
		} else {
			const s = served.get(path);
			if (!s) problems.push(`${path} is in the un-overlaid bundle but neither upstream's nor served`);
			else if (!s.equals(content)) problems.push(`${path} differs from the served file`);
		}
	}
	for (const path of upstream.keys()) if (!unoverlaid.has(path)) problems.push(`upstream's ${path} is missing from the un-overlaid bundle`);
	for (const path of served.keys()) {
		const top = path.split('/')[0];
		if (!unoverlaid.has(path) && !overlayAdded.includes(top) && !upstream.has(path)) problems.push(`the served file ${path} is missing from the un-overlaid bundle`);
	}
	for (const name of overlayAdded) {
		if (name !== 'icons' && unoverlaid.has(name) && !upstream.has(name)) problems.push(`${name} (added by the overlay) is still in the un-overlaid bundle`);
	}

	const root = findRepoRoot();
	const r = spawnSync('corepack', ['yarn', 'workspace', 'web-build', 'verify', '--pin', join(root, 'upstream', 'joplin-version.json'), '--upstream', upstreamGitDir(), dirs.unoverlaid],
		{ cwd: root, encoding: 'utf8', timeout: verifyBound, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', FORCE_COLOR: '0' } });
	const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
	if (r.error) problems.push(`web-build verify could not run: ${r.error.message}`);
	else if (r.status === 0) problems.push('web-build verify passed on the un-overlaid bundle: it is not un-overlaid');
	else {
		const icons = [...upstream.keys()].filter(p => p.startsWith('icons/'));
		for (const name of [...icons, 'environment.js']) if (!output.includes(name)) problems.push(`web-build verify's output does not name ${name}`);
	}
	return problems;
};

export const removeUnoverlaid = (dir: string): void => {
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
};
