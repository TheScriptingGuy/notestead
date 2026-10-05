// Helpers for the M1-S4 tests (docs/test-plans/M1-S4.md): the servable fixture bundle F3, a hand-written ustar writer
// for hostile artifacts (symlinks, `..`, absolute paths, unlisted entries), artifact (re)writers, and the
// `web-build import` runner. Erasable TypeScript only (Node type stripping).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { ensureInstalled, readPin, yarn } from './repo.mts';
import type { Pin, RunOptions, RunResult } from './repo.mts';
import { sha256 } from './upstream.mts';
import { artifactName, headCommit, materialize, readTree, requireWorkspaceScript, upstreamPublicBundle } from './webBundle.mts';
import type { BundleManifest, Tree } from './webBundle.mts';

export const story = 'm1-s4';
export const contract = 'docs/test-plans/M1-S4.md §Command contracts';
const minute = 60_000;

// `corepack yarn workspace web-build <script> …args` with logs under test-results/acceptance/m1-s4/.
export const webBuild = (label: string, script: string, args: string[], opts: RunOptions = {}, logStory = story): RunResult => {
	ensureInstalled(logStory);
	requireWorkspaceScript(script, contract);
	return yarn(logStory, label, ['workspace', 'web-build', script, ...args], { timeoutMs: 10 * minute, ...opts });
};

// `--upstream <dir>` for verify/import when JOPLIN_UPSTREAM_DIR is set (avoids the network), as in M1-S9.
export const upstreamArgs = (): string[] => (process.env.JOPLIN_UPSTREAM_DIR ? ['--upstream', process.env.JOPLIN_UPSTREAM_DIR] : []);

export const runImport = (label: string, artifactDir: string, out: string, extra: string[] = [], logStory = story): RunResult =>
	webBuild(label, 'import', [artifactDir, '--out', out, ...upstreamArgs(), ...extra], {}, logStory);

// ---- Fixture F3: a servable bundle that passes `verify` once overlaid ----

export const noticesName = 'third-party-notices.txt';

// A compressible stand-in for webpack's app bundle, well above Caddy's default `encode` minimum (512 bytes), so the
// compression check (M1-AC12) cannot pass or fail because of the fixture's size. Our own bytes.
export const largeAppBundle = (): Buffer => {
	const lines = ['/*! Notestead M1-S4 synthetic fixture: stands in for the webpack app bundle (64 KiB, compressible). */'];
	for (let i = 0; lines.join('\n').length < 64 * 1024; i++) lines.push(`globalThis.notesteadFixture${i} = { index: ${i}, label: 'notestead fixture line ${i}' };`);
	return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
};

// F3 before the overlay: F2 (upstream:packages/app-mobile/web/public/** at web.commit + synthetic webpack outputs),
// a placeholder third-party-notices.txt (M1-AC29 makes `verify` require it) and the 64 KiB app bundle.
export const servableInputTree = (): Tree => {
	const tree = upstreamPublicBundle();
	tree.set(noticesName, Buffer.from('Third-party notices (M1-S4 fixture placeholder)\n', 'utf8'));
	tree.set('app.bundle.js', largeAppBundle());
	return tree;
};

// F3: servableInputTree() overlaid by the real `overlay` command, in a fresh dir. Returns the dir and its tree.
export const overlaidServable = (label: string, prefix: string, logStory = story): { dir: string; tree: Tree } => {
	const dir = materialize(prefix, servableInputTree());
	const r = webBuild(`${label}-overlay-F3`, 'overlay', [dir], {}, logStory);
	assert.equal(r.code, 0, `the fixture overlay failed (needed to build F3). Log: ${r.logFile}\n${r.output.slice(-2000)}`);
	return { dir, tree: readTree(dir) };
};

// ---- Artifacts ----

export interface ManifestFile {
	path: string;
	sha256: string;
	size: number;
}

export const manifestFiles = (tree: Tree): ManifestFile[] => [...tree.entries()]
	.map(([path, content]) => ({ path, sha256: sha256(content), size: content.length }))
	.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

export const manifestFor = (pin: Pin, files: ManifestFile[]): BundleManifest & { notestead: { commit: string; dirty: boolean } } => ({
	upstream: { repo: pin.web.repo, tag: pin.web.tag, commit: pin.web.commit },
	notestead: { commit: headCommit(), dirty: false },
	files,
});

// SHA256SUMS in sha256sum(1) format for the given files of `dir`.
export const sumsText = (dir: string, names: string[]): string =>
	[...names].sort().map(name => `${sha256(readFileSync(join(dir, name)))}  ${name}\n`).join('');

// Rewrites SHA256SUMS so it matches the tarball and manifest currently in `dir` (isolates later checks from the
// checksum check).
export const resum = (dir: string, pin: Pin = readPin()): void => {
	writeFileSync(join(dir, 'SHA256SUMS'), sumsText(dir, [artifactName(pin), 'bundle-manifest.json']));
};

export const writeManifest = (dir: string, manifest: unknown): void => {
	writeFileSync(join(dir, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
};

export const readManifest = (dir: string): BundleManifest => JSON.parse(readFileSync(join(dir, 'bundle-manifest.json'), 'utf8')) as BundleManifest;

// Copies the three artifact files of `from` into a new dir `to`.
export const copyArtifact = (from: string, to: string): string => {
	mkdirSync(to, { recursive: true });
	for (const name of readdirSync(from)) writeFileSync(join(to, name), readFileSync(join(from, name)));
	return to;
};

// ---- A minimal ustar writer (POSIX 1003.1-1988), so the hostile entries are exactly what the test says ----

export type TarEntryType = 'file' | 'dir' | 'symlink' | 'hardlink';

export interface TarEntry {
	name: string;
	type: TarEntryType;
	content?: Buffer;
	linkname?: string;
}

const typeFlag: Record<TarEntryType, string> = { file: '0', hardlink: '1', symlink: '2', dir: '5' };

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`;

const header = (entry: TarEntry, size: number): Buffer => {
	const block = Buffer.alloc(512, 0);
	assert.ok(Buffer.byteLength(entry.name) <= 100, `fixture tar entry name too long for this writer: ${entry.name}`);
	block.write(entry.name, 0, 100, 'utf8');
	block.write(octal(entry.type === 'dir' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
	block.write(octal(0, 8), 108, 8, 'ascii');
	block.write(octal(0, 8), 116, 8, 'ascii');
	block.write(octal(size, 12), 124, 12, 'ascii');
	block.write(octal(1_760_000_000, 12), 136, 12, 'ascii');
	block.write('        ', 148, 8, 'ascii');
	block.write(typeFlag[entry.type], 156, 1, 'ascii');
	if (entry.linkname) block.write(entry.linkname, 157, 100, 'utf8');
	block.write('ustar\0', 257, 6, 'ascii');
	block.write('00', 263, 2, 'ascii');
	block.write('root', 265, 32, 'ascii');
	block.write('root', 297, 32, 'ascii');
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
	return block;
};

export const ustar = (entries: TarEntry[]): Buffer => {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const content = entry.type === 'file' ? (entry.content ?? Buffer.alloc(0)) : Buffer.alloc(0);
		blocks.push(header(entry, content.length));
		if (content.length > 0) {
			blocks.push(content);
			const pad = (512 - (content.length % 512)) % 512;
			if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
		}
	}
	blocks.push(Buffer.alloc(1024, 0));
	return Buffer.concat(blocks);
};

export const treeEntries = (tree: Tree): TarEntry[] =>
	manifestFiles(tree).map(file => ({ name: file.path, type: 'file' as const, content: tree.get(file.path) }));

// Writes a complete artifact into `dir` (created): a zstd-compressed ustar of `entries`, a manifest listing
// `listed`, and a SHA256SUMS that matches both, so only the property under test is wrong.
export const writeHandmadeArtifact = (dir: string, entries: TarEntry[], listed: ManifestFile[], pin: Pin = readPin()): string => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, artifactName(pin)), zstdCompressSync(ustar(entries)));
	writeManifest(dir, manifestFor(pin, listed));
	resum(dir, pin);
	return dir;
};

// ---- Output-dir probes ----

export const absentOrEmpty = (dir: string): boolean => !existsSync(dir) || readdirSync(dir).length === 0;

export const describeDir = (dir: string): string => (existsSync(dir) ? JSON.stringify(readdirSync(dir).slice(0, 20)) : '(absent)');
