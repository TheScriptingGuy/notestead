// Helpers for the M1-S2 web-bundle acceptance tests (docs/test-plans/M1-S2.md): fixture bundles, file-tree
// snapshots, HTML probes, an environment.js probe and artifact checks. Erasable TypeScript only.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import vm from 'node:vm';
import {
	assertExitZero, ensureInstalled, git, makeTempDir, readJson, repoRoot, run, yarn,
} from './repo.mts';
import type { Pin, RunOptions, RunResult } from './repo.mts';
import { sha256, upstreamPublicFiles } from './upstream.mts';

export const story = 'm1-s2';
export const webBuildDir = join(repoRoot, 'packages', 'web-build');
export const overlayJsonPath = join(webBuildDir, 'overlay.json');
export const officialName = 'Notestead for Joplin (unofficial)';
export const officialShortName = 'Notestead';

const minute = 60_000;

// ---- Running the web-build workspace scripts ----

interface Manifest {
	scripts?: Record<string, string>;
}

// Fails with a contract message (not yarn's "Couldn't find a script") when the workspace script is missing, so a
// missing script can never satisfy a negative test.
// `contract` names the test plan section that defines the script, so a RED failure points at the right story.
export const requireWorkspaceScript = (script: string, contract = 'docs/test-plans/M1-S2.md §Command contracts'): void => {
	const path = join(webBuildDir, 'package.json');
	assert.ok(existsSync(path), `${relative(repoRoot, path)} does not exist`);
	const scripts = readJson<Manifest>(path).scripts ?? {};
	assert.ok(typeof scripts[script] === 'string' && scripts[script].trim() !== '',
		`Contract (${contract}): packages/web-build/package.json must define the script "${script}". Found: ${JSON.stringify(Object.keys(scripts))}`);
};

// `corepack yarn workspace web-build <script> …args`. Paths in args must be absolute: yarn runs workspace scripts
// with the workspace directory as cwd.
export const webBuild = (label: string, script: string, args: string[], opts: RunOptions = {}): RunResult => {
	ensureInstalled(story);
	requireWorkspaceScript(script);
	return yarn(story, label, ['workspace', 'web-build', script, ...args], { timeoutMs: 10 * minute, ...opts });
};

// Setup in `before` hooks goes through attempt(): a throwing hook would cancel the tests instead of failing each one
// with the reason, so the error is kept and rethrown by settled() inside every test that needs the setup.
export interface Attempt<T> {
	value: T | null;
	error: unknown;
}

export const attempt = <T,>(fn: () => T): Attempt<T> => {
	try {
		return { value: fn(), error: null };
	} catch (error) {
		return { value: null, error };
	}
};

export const settled = <T,>(a: Attempt<T> | null): T => {
	assert.ok(a, 'the test setup did not run');
	if (a.error !== null) throw a.error;
	return a.value as T;
};

export const headCommit = (): string => git(repoRoot, ['rev-parse', 'HEAD']).trim();

// ---- File trees ----

export type Tree = Map<string, Buffer>;

const toPosix = (p: string): string => p.split(sep).join('/');

// Every regular file under `dir`, keyed by its POSIX path relative to `dir`. Symlinks and other special files fail.
export const readTree = (dir: string): Tree => {
	assert.ok(existsSync(dir), `${dir} does not exist`);
	const tree: Tree = new Map();
	const walk = (d: string): void => {
		for (const entry of readdirSync(d).sort()) {
			const p = join(d, entry);
			const stats = lstatSync(p);
			if (stats.isDirectory()) walk(p);
			else if (stats.isFile()) tree.set(toPosix(relative(dir, p)), readFileSync(p));
			else assert.fail(`${p} is neither a regular file nor a directory`);
		}
	};
	walk(dir);
	return tree;
};

export const writeTree = (dir: string, tree: Tree): void => {
	for (const [path, content] of tree) {
		const target = join(dir, ...path.split('/'));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
};

// A fresh temp dir holding `tree`; the caller removes it.
export const materialize = (prefix: string, tree: Tree): string => {
	const dir = makeTempDir(prefix);
	writeTree(dir, tree);
	return dir;
};

export const hashesOf = (tree: Tree): Map<string, string> => {
	const hashes = new Map<string, string>();
	for (const [path, content] of tree) hashes.set(sha256(content), path);
	return hashes;
};

const text = (s: string): Buffer => Buffer.from(s, 'utf8');

// Stand-ins for the webpack outputs of `yarn web` (our own bytes). The overlay must leave them byte-identical.
const syntheticWebpackOutputs = (): Tree => new Map<string, Buffer>([
	['app.bundle.js', text('/*! Notestead M1-S2 synthetic fixture: stands in for the webpack app bundle. */\n(() => { globalThis.notesteadFixtureLoaded = true; })();\n')],
	['app.bundle.js.LICENSE.txt', text('/*! Notestead M1-S2 synthetic fixture licence notice (MIT) */\n')],
	['serviceWorker.bundle.js', text('/*! Notestead M1-S2 synthetic fixture service worker */\nself.addEventListener("fetch", () => undefined);\n')],
	['528.bundle.js', text('/*! Notestead M1-S2 synthetic fixture chunk */\n')],
	['0f1e2d3c4b5a69788796.wasm', Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])],
	['a1b2c3d4e5f60718293a.ttf', Buffer.from(Array.from({ length: 256 }, (_v, i) => (i * 37) % 256))],
	['pluginAssets/katex/katex.css', text('/* Notestead M1-S2 synthetic fixture plugin asset */\n.katex { font-size: 1em; }\n')],
]);

// Names that ADR-0010's overlay table and M1-AC6 address, plus the webpack outputs above.
export const webpackOutputPaths = [...syntheticWebpackOutputs().keys()];

// Fixture F1: a small synthetic `dist/` with the layout of the upstream web build, written from scratch (no
// upstream content). Its index.html has a multi-line CSP <meta> whose exact bytes the overlay must keep.
export const syntheticBundle = (): Tree => {
	const tree = syntheticWebpackOutputs();
	tree.set('index.html', text([
		'<!DOCTYPE html>',
		'<html>',
		'\t<head>',
		'\t\t<meta charset="utf-8"/>',
		'\t\t<!-- Notestead M1-S2 synthetic fixture page -->',
		'\t\t<meta',
		'\t\t\thttp-equiv="Content-Security-Policy"',
		'\t\t\tcontent="',
		'\t\t\t\tdefault-src \'self\' ;',
		'\t\t\t\tconnect-src \'self\' https://* blob: ;',
		'\t\t\t\tscript-src \'self\' \'unsafe-inline\' ;',
		'\t\t\t\timg-src \'self\' data: blob: ;',
		'\t\t\t"',
		'\t\t/>',
		'\t\t<link rel="manifest" href="./manifest.json"/>',
		'\t\t<link rel="icon" href="./icons/icon-vector-large.svg"/>',
		'\t\t<link rel="apple-touch-icon" href="./icons/icon-192.png"/>',
		'\t\t<meta name="description" content="Fixture Notes Web, a synthetic test page."/>',
		'\t\t<meta property="og:image" content="./icons/icon-192.png"/>',
		'\t\t<title>Fixture Notes</title>',
		'\t\t<script src="./environment.js"></script>',
		'\t\t<script src="./serviceWorker.bundle.js"></script>',
		'\t</head>',
		'\t<body><div id="root"></div></body>',
		'\t<script defer src="./app.bundle.js"></script>',
		'</html>',
	].join('\n')));
	tree.set('environment.js', text([
		'// Notestead M1-S2 synthetic fixture: dev mode follows the origin, like the file it stands in for.',
		'window.__DEV__ = /localhost/.test(window.location.origin);',
		'window.exports = {};',
		'window.process = { env: { EXPO_OS: \'web\' } };',
		'if (window.__DEV__) document.title = \'Fixture Notes DEV\';',
		'',
	].join('\n')));
	tree.set('manifest.json', text(`${JSON.stringify({
		short_name: 'Fixture',
		name: 'Fixture Notes Web',
		icons: [
			{ src: './icons/icon-vector-large.svg', type: 'image/svg+xml', sizes: '512x512', purpose: 'maskable' },
			{ src: './icons/icon-512.png', type: 'image/png', sizes: '512x512' },
			{ src: './icons/icon-256.png', type: 'image/png', sizes: '256x256' },
			{ src: './icons/icon-192.png', type: 'image/png', sizes: '192x192' },
			{ src: './icons/icon-64.png', type: 'image/png', sizes: '64x64' },
		],
		screenshots: [
			{ src: './screenshots/tall.png', sizes: '100x200', form_factor: 'narrow', label: 'Fixture narrow screenshot' },
			{ src: './screenshots/wide.png', sizes: '200x100', form_factor: 'wide', label: 'Fixture wide screenshot' },
		],
		start_url: './',
		background_color: '#123456',
		display: 'standalone',
	}, null, 4)}\n`));
	for (const name of ['icon-64.png', 'icon-192.png', 'icon-256.png', 'icon-512.png', 'icon-large.png', 'icon-vector-large.svg']) {
		tree.set(`icons/${name}`, text(`Notestead M1-S2 synthetic fixture icon ${name}\n`));
	}
	tree.set('screenshots/tall.png', text('Notestead M1-S2 synthetic fixture screenshot (tall)\n'));
	tree.set('screenshots/wide.png', text('Notestead M1-S2 synthetic fixture screenshot (wide)\n'));
	for (const [name, title] of [['closed.html', 'Closed - Fixture Notes'], ['just-one-client.html', 'Error - Fixture Notes']]) {
		tree.set(name, text([
			'<!DOCTYPE html>',
			'<html lang="en">',
			'\t<head>',
			'\t\t<meta charset="utf-8"/>',
			'\t\t<link rel="icon" href="./icons/icon-vector-large.svg"/>',
			`\t\t<title>${title}</title>`,
			'\t\t<script src="./serviceWorker.bundle.js"></script>',
			'\t\t<link rel="stylesheet" href="./info-page.css"/>',
			'\t</head>',
			`\t<body><main><h1>${title}</h1></main></body>`,
			'</html>',
		].join('\n')));
	}
	tree.set('index.css', text('/* Notestead M1-S2 synthetic fixture */\nbody { margin: 0; }\n'));
	tree.set('info-page.css', text('/* Notestead M1-S2 synthetic fixture */\nmain { padding: 1em; }\n'));
	return tree;
};

// Fixture F2: the un-overlaid upstream static files (upstream:packages/app-mobile/web/public/** at web.commit,
// exactly what `yarn web` copies into dist/) plus the synthetic webpack outputs. Generated at test time, never committed.
export const upstreamPublicBundle = (): Tree => {
	const tree = syntheticWebpackOutputs();
	for (const [path, content] of upstreamPublicFiles()) tree.set(path, content);
	return tree;
};

// ---- HTML probes ----

// The raw source text of every Content-Security-Policy <meta> element (from "<meta" to its closing ">").
export const cspMetas = (html: string): string[] =>
	[...html.matchAll(/<meta\b[^>]*?http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi)].map(m => m[0]);

// The raw opening tag of every <script> element, in document order.
export const scriptTags = (html: string): string[] => [...html.matchAll(/<script\b[^>]*>/gi)].map(m => m[0]);

// Every same-directory reference (`href="./x"`, `src="./x"`, `content="./x"`) in an HTML page, as a dist path.
export const localRefs = (html: string): string[] =>
	[...html.matchAll(/\b(?:href|src|content)\s*=\s*"\.\/([^"?#]*)"/gi)].map(m => m[1]).filter(p => p !== '');

// ---- environment.js probe ----

export interface EnvironmentProbe {
	dev: unknown;
	exportsType: string;
	expoOs: unknown;
	title: unknown;
}

// Runs an environment.js in a fresh VM context whose global object is `window` (as in a browser), at `origin`.
export const probeEnvironment = (code: string, origin: string): EnvironmentProbe => {
	const document = { title: 'probe-title' };
	const sandbox: Record<string, unknown> = { location: { origin, href: `${origin}/`, hostname: new URL(origin).hostname }, document };
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'environment.js', timeout: 1000 });
	const processValue = sandbox.process as { env?: { EXPO_OS?: unknown } } | undefined;
	return {
		dev: sandbox.__DEV__,
		exportsType: typeof sandbox.exports,
		expoOs: processValue?.env?.EXPO_OS,
		title: document.title,
	};
};

// Origins on which the overlaid bundle must run with __DEV__ === false (ADR-0010: "on any origin").
export const probeOrigins = ['http://localhost:8080', 'http://127.0.0.1:8080', 'https://localhost.example.org', 'https://notes.example.com'];

// ---- Artifacts (M1-AC5) ----

export interface BundleManifestFile {
	path: string;
	sha256: string;
	size: number;
}

export interface BundleManifest {
	upstream?: { repo?: unknown; tag?: unknown; commit?: unknown };
	notestead?: { commit?: unknown };
	files?: BundleManifestFile[];
}

export const artifactName = (pin: Pin): string => `web-bundle-${pin.web.tag}.tar.zst`;

export interface Artifact {
	extractedDir: string;
	extracted: Tree;
	manifest: BundleManifest;
}

const isPlainRelative = (p: string): boolean =>
	p !== '' && !p.startsWith('/') && !p.split('/').some(segment => segment === '..');

// Checks the three outputs of `build`/`package` in `outDir` against the pin and our commit, extracts the tarball
// into `extractInto` and returns the extracted tree. When `expected` is given, the extracted tree must equal it.
export const assertArtifact = (label: string, outDir: string, pin: Pin, extractInto: string, expected: Tree | null): Artifact => {
	const tarName = artifactName(pin);
	assert.deepEqual(readdirSync(outDir).sort(), ['SHA256SUMS', 'bundle-manifest.json', tarName].sort(),
		`${outDir} must contain exactly ${tarName}, SHA256SUMS and bundle-manifest.json`);

	// SHA256SUMS: sha256sum format, covering the tarball and the manifest, with correct hashes.
	const sums = new Map<string, string>();
	for (const line of readFileSync(join(outDir, 'SHA256SUMS'), 'utf8').split('\n').filter(l => l.trim() !== '')) {
		const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
		assert.ok(m, `SHA256SUMS line is not in sha256sum format: ${JSON.stringify(line)}`);
		sums.set(m[2], m[1]);
	}
	for (const name of [tarName, 'bundle-manifest.json']) {
		assert.equal(sums.get(name), sha256(readFileSync(join(outDir, name))), `SHA256SUMS entry for ${name}`);
	}
	assertExitZero(run(story, `${label}-sha256sum-check`, 'sha256sum', ['-c', 'SHA256SUMS'], { cwd: outDir }));

	// Tarball: zstd-compressed tar of plain relative paths, regular files and directories only.
	const tarPath = join(outDir, tarName);
	const names = run(story, `${label}-tar-list`, 'tar', ['--zstd', '-tf', tarPath]);
	assertExitZero(names);
	const types = run(story, `${label}-tar-list-verbose`, 'tar', ['--zstd', '-tvf', tarPath]);
	assertExitZero(types);
	const nameLines = names.stdout.split('\n').filter(l => l !== '');
	const typeLines = types.stdout.split('\n').filter(l => l !== '');
	assert.equal(nameLines.length, typeLines.length, 'tar listings disagree');
	nameLines.forEach((name, i) => {
		const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
		if (normalized === '' || normalized === '.') return;
		assert.ok(isPlainRelative(normalized), `tar entry ${JSON.stringify(name)} is absolute or escapes the bundle root`);
		assert.ok(typeLines[i].startsWith('-') || typeLines[i].startsWith('d'),
			`tar entry ${JSON.stringify(name)} is not a regular file or directory: ${typeLines[i]}`);
	});
	assertExitZero(run(story, `${label}-tar-extract`, 'tar', ['--zstd', '-xf', tarPath, '-C', extractInto]));
	const extracted = readTree(extractInto);
	assert.ok(extracted.has('index.html'), `the bundle has no index.html at its root (entries: ${[...extracted.keys()].slice(0, 10).join(', ')} …)`);

	if (expected) {
		assert.deepEqual([...extracted.keys()].sort(), [...expected.keys()].sort(), 'the tarball must contain exactly the bundle files');
		for (const [path, content] of expected) {
			assert.ok(extracted.get(path)?.equals(content), `${path} in the tarball differs from the packaged dist`);
		}
	}

	// bundle-manifest.json: upstream and our commit, and every file with its sha256 and size.
	const manifest = readJson<BundleManifest>(join(outDir, 'bundle-manifest.json'));
	assert.equal(manifest.upstream?.repo, pin.web.repo, 'bundle-manifest.json upstream.repo');
	assert.equal(manifest.upstream?.tag, pin.web.tag, 'bundle-manifest.json upstream.tag');
	assert.equal(manifest.upstream?.commit, pin.web.commit, 'bundle-manifest.json upstream.commit');
	assert.equal(manifest.notestead?.commit, headCommit(), 'bundle-manifest.json notestead.commit (git rev-parse HEAD)');
	assert.ok(Array.isArray(manifest.files), 'bundle-manifest.json files must be an array of {path, sha256, size}');
	const listed = manifest.files.map(f => f.path);
	assert.deepEqual(listed, [...listed].sort(), 'bundle-manifest.json files must be sorted by path');
	assert.deepEqual([...listed].sort(), [...extracted.keys()].sort(), 'bundle-manifest.json must list every file in the tarball, and only those');
	for (const file of manifest.files) {
		const content = extracted.get(file.path);
		assert.ok(content, `${file.path} is listed but not in the tarball`);
		assert.equal(file.sha256, sha256(content), `bundle-manifest.json sha256 of ${file.path}`);
		assert.equal(file.size, content.length, `bundle-manifest.json size of ${file.path}`);
	}
	return { extractedDir: extractInto, extracted, manifest };
};
