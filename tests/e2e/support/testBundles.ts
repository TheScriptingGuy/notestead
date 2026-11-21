// Derived test bundles for M2-S5 (docs/test-plans/M2-S5.md D1-D3): the served bundle A, B and B2 (a changed bundle) and O (an
// older database version). This part is pure: strings in, strings out, unit-tested on synthetic input (tb-01…08). The bundles
// hold upstream's files and are only ever written under test-results/, never committed.
import { createHash } from 'node:crypto';

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
