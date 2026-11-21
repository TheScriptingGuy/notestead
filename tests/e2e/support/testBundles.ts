// Derived test bundles for M2-S5 (docs/test-plans/M2-S5.md D1-D3): the served bundle A, B and B2 (a changed bundle) and O (an
// older database version). This part is pure: strings in, strings out, unit-tested on synthetic input (tb-01…08). The bundles
// hold upstream's files and are only ever written under test-results/, never committed.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { StackState } from '../../stack/stack.ts';

export interface BundleFile { path: string; sha256: string; size: number }
export interface BundleManifest {
	upstream: { repo: string; tag: string; commit: string };
	notestead: { commit: string; dirty: boolean; testBundle?: 'B' | 'B2' | 'O' };
	files: BundleFile[];
}

export interface MigrationVersions { base: number; n: number; latest: number }

// The database version the bundle's compiled migration list ends at: the last element of the `existingDatabaseVersions` literal
// in upstream:packages/lib/JoplinDatabase.ts, plus one version per entry of the array exported by
// upstream:packages/lib/services/database/migrations/index.ts (D3).
export const migrationVersions = (upstreamDatabaseTs: string, upstreamIndexTs: string): MigrationVersions => {
	const literal = /existingDatabaseVersions\s*=\s*\[([^\]]*)\]/.exec(upstreamDatabaseTs);
	if (!literal) throw new Error('JoplinDatabase.ts has no `existingDatabaseVersions = [...]` literal');
	const numbers = literal[1].split(',').map(s => s.trim()).filter(s => s !== '');
	if (numbers.length === 0 || numbers.some(s => !/^\d+$/.test(s))) throw new Error(`the existingDatabaseVersions literal is not a list of integers (${numbers.length} elements)`);
	const base = Number(numbers[numbers.length - 1]);
	const array = /const\s+index\s*:\s*Migration\[\]\s*=\s*\[([\s\S]*?)\]\s*;/.exec(upstreamIndexTs);
	if (!array) throw new Error('migrations/index.ts has no `const index: Migration[] = [...]` array');
	const entries = array[1].split(',').map(s => s.trim()).filter(s => s !== '');
	if (entries.length === 0) throw new Error('the migrations array has no entries (found 0)');
	if (entries.some(s => !/^migration\d+$/.test(s))) throw new Error(`the migrations array has an entry that is not migration<N> (${entries.length} entries)`);
	return { base, n: entries.length, latest: base + entries.length };
};

// A final line of its own: `\n<line>\n` when the text does not end with a newline, else `<line>\n`.
export const appendLine = (text: string, line: string): string => `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;

const identifier = '[A-Za-z_$][\\w$]*';
const moduleStart = new RegExp(`[,{](\\d+):(?:function)?\\(${'[\\w$,]*'}\\)(?:=>)?\\{`, 'g');

const countMatches = (text: string, pattern: RegExp): RegExpExecArray[] => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];

// O (D3): the bundle's migration list without its newest entry. Two independent anchors, both must agree:
//   1. the one `<v>.default[<x>-<base+1>]` (the `migrations[targetVersion - 42]` lookup) names the variable <v>; in the same module
//      `<v>=<wrap>(<req>(<id>))` names the module id of the migration index;
//   2. that module's body has exactly one array literal of `<name>.default` entries, `n` of them, assigned to its default export.
// A mismatch throws with counts only, never bundle text.
export const dropNewestMigration = (appBundleJs: string, expected: { base: number; n: number }): { js: string; before: number; after: number } => {
	const anchors = countMatches(appBundleJs, new RegExp(`(${identifier})\\.default\\[${identifier}-${expected.base + 1}\\]`));
	if (anchors.length !== 1) throw new Error(`expected exactly one migration lookup anchor (<v>.default[<x>-${expected.base + 1}]), found ${anchors.length}`);
	const variable = anchors[0][1];
	const anchorAt = anchors[0].index;

	// the module that holds the anchor: the last module start before it
	const starts = countMatches(appBundleJs.slice(0, anchorAt), moduleStart);
	if (starts.length === 0) throw new Error('the migration lookup anchor is not inside a module (no module start before it)');
	const dbModuleAt = starts[starts.length - 1].index;
	const dbModule = appBundleJs.slice(dbModuleAt, anchorAt);
	const wraps = countMatches(dbModule, new RegExp(`(?<![\\w$])${variable.replace(/\$/g, '\\$')}=${identifier}\\(${identifier}\\((\\d+)\\)\\)`));
	if (wraps.length !== 1) throw new Error(`expected exactly one \`${'<v>'}=<wrap>(<req>(<id>))\` in the module of the anchor, found ${wraps.length}`);
	const id = wraps[0][1];

	const target = countMatches(appBundleJs, new RegExp(`[,{]${id}:(?:function)?\\(${'[\\w$,]*'}\\)(?:=>)?\\{`));
	if (target.length !== 1) throw new Error(`expected exactly one module ${id} (the migration index), found ${target.length}`);
	const bodyStart = target[0].index;
	const next = /\},\d+:/.exec(appBundleJs.slice(bodyStart + 1));
	const bodyEnd = next ? bodyStart + 1 + next.index : appBundleJs.length;
	const body = appBundleJs.slice(bodyStart, bodyEnd);

	const arrays = countMatches(body, new RegExp(`(${identifier})=\\[((?:${identifier}\\.default,)+${identifier}\\.default)\\]`));
	if (arrays.length !== 1) throw new Error(`expected exactly one array of <name>.default entries in module ${id}, found ${arrays.length} arrays`);
	const [whole, name, list] = arrays[0];
	const entries = list.split(',');
	if (entries.length !== expected.n) throw new Error(`the migration array of module ${id} has the wrong size: expected ${expected.n} entries, found ${entries.length}`);
	if (!new RegExp(`\\.default=${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)) throw new Error(`the migration array of module ${id} is not the module's default export`);

	const kept = `${name}=[${entries.slice(0, -1).join(',')}]`;
	const at = bodyStart + arrays[0].index;
	return { js: appBundleJs.slice(0, at) + kept + appBundleJs.slice(at + whole.length), before: entries.length, after: entries.length - 1 };
};

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// A copy of `base` whose changed files carry their new digest and size, marked as a test bundle. Nothing of `base` is touched.
export const manifestWith = (base: BundleManifest, changes: { path: string; bytes: Buffer }[], testBundle: 'B' | 'B2' | 'O'): BundleManifest => {
	const files = base.files.map(f => ({ ...f }));
	for (const change of changes) {
		const file = files.find(f => f.path === change.path);
		if (!file) throw new Error(`${change.path} is not in the bundle manifest`);
		file.sha256 = sha256(change.bytes);
		file.size = change.bytes.length;
	}
	return { upstream: { ...base.upstream }, notestead: { ...base.notestead, testBundle }, files };
};

// ---- The bundles on disk (D1-D3). Only ever under test-results/, removed at worker teardown, never committed. ----

export interface TestBundles {
	// directories: A is the tree the stack's web serves, B/B2/O are derived from it
	a: string; b: string; b2: string; o: string;
	// each derived bundle's own manifest (A's is the artifact's), the oracle for "serves bundle X"
	manifests: { a: BundleManifest; b: BundleManifest; b2: BundleManifest; o: BundleManifest };
	versions: MigrationVersions;
	nonce: string;
}

export type TreeDigests = Map<string, { sha256: string; size: number }>;

// Every regular file under `dir`, by its path relative to it, with its sha256 and size.
export const treeDigests = (dir: string): TreeDigests => {
	const files: TreeDigests = new Map();
	const visit = (d: string): void => {
		for (const entry of readdirSync(d).sort()) {
			const p = join(d, entry);
			const stats = lstatSync(p);
			if (stats.isDirectory()) {
				visit(p);
			} else if (stats.isFile()) {
				const bytes = readFileSync(p);
				files.set(relative(dir, p).split(sep).join('/'), { sha256: sha256(bytes), size: bytes.length });
			} else {
				throw new Error(`${p} is neither a regular file nor a directory`);
			}
		}
	};
	visit(dir);
	return files;
};

const artifactManifest = (): BundleManifest => {
	const dir = process.env.NOTESTEAD_WEB_ARTIFACT;
	if (!dir) throw new Error('M2-S5 needs NOTESTEAD_WEB_ARTIFACT (the artifact the web image was built from): its bundle-manifest.json describes the served tree the derived bundles are checked against');
	try {
		return JSON.parse(readFileSync(join(dir, 'bundle-manifest.json'), 'utf8')) as BundleManifest;
	} catch (error) {
		throw new Error(`M2-S5 needs NOTESTEAD_WEB_ARTIFACT (the artifact the web image was built from): ${dir}/bundle-manifest.json is unreadable (${(error as Error).message})`);
	}
};

const marker = (bundle: 'B' | 'B2' | 'O', nonce: string): string => `${bundle}-${nonce}`;
const environmentLine = (bundle: 'B' | 'B2' | 'O', nonce: string): string => `globalThis.notesteadTestBundle = '${marker(bundle, nonce)}';`;
const commentLine = (bundle: 'B' | 'B2', nonce: string): string => `/* notestead-test-bundle ${marker(bundle, nonce)} */`;

// D1-D3: A is a copy of what the stack's web serves; B, B2 and O are copies of A with their own changes and their own manifest
// written beside the tree. `root` is wiped first. `nonce` is the worker's random marker suffix.
export const buildTestBundles = async (stack: StackState, root: string, nonce: string): Promise<TestBundles> => {
	// Loaded here, not at the top: these modules read upstream's tree through tests/acceptance/support/upstream.mts (ESM with
	// import.meta, which Jest's CommonJS transform cannot parse), and the Jest unit tests import this module's pure functions.
	const { copyServedTree, normalizeModes } = await import('./unoverlaid.ts');
	const { upstreamFileAt } = await import('../../acceptance/support/upstream.mts');
	const versions = migrationVersions(
		upstreamFileAt('packages/lib/JoplinDatabase.ts').toString('utf8'),
		upstreamFileAt('packages/lib/services/database/migrations/index.ts').toString('utf8'),
	);
	const manifestA = artifactManifest();

	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	const dirs = { a: join(root, 'a'), b: join(root, 'b'), b2: join(root, 'b2'), o: join(root, 'o') };
	copyServedTree(stack, dirs.a);
	for (const name of ['b', 'b2', 'o'] as const) cpSync(dirs.a, dirs[name], { recursive: true });

	const read = (dir: string, path: string): string => readFileSync(join(dir, path), 'utf8');
	const changes = (dir: string, files: Record<string, string>): { path: string; bytes: Buffer }[] => {
		const out: { path: string; bytes: Buffer }[] = [];
		for (const [path, text] of Object.entries(files)) {
			writeFileSync(join(dir, path), text);
			out.push({ path, bytes: Buffer.from(text, 'utf8') });
		}
		return out;
	};
	const aApp = read(dirs.a, 'app.bundle.js');
	const aEnv = read(dirs.a, 'environment.js');
	const aWorker = read(dirs.a, 'serviceWorker.bundle.js');

	const b = changes(dirs.b, { 'environment.js': appendLine(aEnv, environmentLine('B', nonce)), 'app.bundle.js': appendLine(aApp, commentLine('B', nonce)) });
	const b2 = changes(dirs.b2, {
		'environment.js': appendLine(aEnv, environmentLine('B2', nonce)),
		'app.bundle.js': appendLine(aApp, commentLine('B2', nonce)),
		'serviceWorker.bundle.js': appendLine(aWorker, commentLine('B2', nonce)),
	});
	const o = changes(dirs.o, { 'environment.js': appendLine(aEnv, environmentLine('O', nonce)), 'app.bundle.js': dropNewestMigration(aApp, versions).js });

	const manifests = {
		a: manifestA,
		b: manifestWith(manifestA, b, 'B'),
		b2: manifestWith(manifestA, b2, 'B2'),
		o: manifestWith(manifestA, o, 'O'),
	};
	for (const name of ['b', 'b2', 'o'] as const) writeFileSync(join(root, `${name}.bundle-manifest.json`), `${JSON.stringify(manifests[name], null, '\t')}\n`);
	for (const dir of Object.values(dirs)) normalizeModes(dir);
	return { ...dirs, manifests, versions, nonce };
};

const treeAgainstManifest = (label: string, dir: string, manifest: BundleManifest): string[] => {
	const problems: string[] = [];
	const tree = treeDigests(dir);
	const listed = new Map(manifest.files.map(f => [f.path, f]));
	for (const [path, f] of listed) {
		const actual = tree.get(path);
		if (!actual) problems.push(`${label}: ${path} is in the manifest and missing from the tree`);
		else if (actual.sha256 !== f.sha256 || actual.size !== f.size) problems.push(`${label}: ${path} differs from its manifest entry`);
	}
	for (const path of tree.keys()) if (!listed.has(path)) problems.push(`${label}: ${path} is in the tree and not in the manifest`);
	return problems;
};

// The D1 self-check: the problems with the bundles (empty: they are what they claim to be). Names paths and counts, never content.
export const checkTestBundles = (bundles: TestBundles): string[] => {
	const problems: string[] = [];
	// A is the artifact's tree, and every derived manifest describes its own tree
	for (const name of ['a', 'b', 'b2', 'o'] as const) problems.push(...treeAgainstManifest(name.toUpperCase(), bundles[name], bundles.manifests[name]));
	const a = treeDigests(bundles.a);
	const expectedChanges = { b: ['app.bundle.js', 'environment.js'], b2: ['app.bundle.js', 'environment.js', 'serviceWorker.bundle.js'], o: ['app.bundle.js', 'environment.js'] };
	for (const name of ['b', 'b2', 'o'] as const) {
		const t = treeDigests(bundles[name]);
		const differing = [...new Set([...a.keys(), ...t.keys()])].filter(p => a.get(p)?.sha256 !== t.get(p)?.sha256).sort();
		if (JSON.stringify(differing) !== JSON.stringify(expectedChanges[name])) problems.push(`${name.toUpperCase()} differs from A in [${differing.join(', ')}], expected [${expectedChanges[name].join(', ')}]`);
	}
	// O: A's migration list without its newest entry, nothing else in the app bundle
	try {
		const aJs = readFileSync(join(bundles.a, 'app.bundle.js'), 'utf8');
		const oJs = readFileSync(join(bundles.o, 'app.bundle.js'), 'utf8');
		const dropped = dropNewestMigration(aJs, bundles.versions);
		if (dropped.js !== oJs) problems.push('O\'s app bundle is not A\'s with its newest migration removed');
		if (dropped.after !== bundles.versions.n - 1) problems.push(`O's migration list has ${dropped.after} entries, expected ${bundles.versions.n - 1}`);
	} catch (error) {
		problems.push(`O's self-check: ${(error as Error).message}`);
	}
	// the markers
	for (const [name, bundle] of [['b', 'B'], ['b2', 'B2'], ['o', 'O']] as const) {
		const env = readFileSync(join(bundles[name], 'environment.js'), 'utf8');
		if (!env.endsWith(`\n${environmentLine(bundle, bundles.nonce)}\n`)) problems.push(`${bundle}'s environment.js does not end with its marker line`);
	}
	if (existsSync(join(bundles.a, 'environment.js')) && readFileSync(join(bundles.a, 'environment.js'), 'utf8').includes('notesteadTestBundle')) problems.push('A\'s environment.js has a test marker');
	return problems;
};

export const removeTestBundles = (root: string): void => {
	rmSync(root, { recursive: true, force: true });
};
