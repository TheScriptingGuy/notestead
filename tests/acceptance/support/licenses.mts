// Helpers for the M1-S9 licence and provenance tests (docs/test-plans/M1-S9.md): synthetic installed trees, an
// independent walker over installed packages, a yarn.lock (Berry) parser with the app-mobile dependency closure,
// and a parser for the third-party-notices.txt contract. These are the tests' own reference implementations: they
// never import production code, so a shared bug cannot make both sides agree. Erasable TypeScript only.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const toPosix = (p: string): string => p.split(sep).join('/');

// ---- Synthetic installed trees ----

export interface PackageSpec {
	// Directory of the package relative to the tree root, e.g. `node_modules/foo` or `packages/ws/node_modules/@s/bar`.
	dir: string;
	// The package.json content, written verbatim.
	manifest: Record<string, unknown>;
	// Extra files relative to the package directory (licence files, nested decoy manifests, …).
	files?: Record<string, string>;
}

export const manifest = (name: string, version: string, fields: Record<string, unknown> = {}): Record<string, unknown> =>
	({ name, version, ...fields });

export const writeFiles = (root: string, files: Record<string, string>): void => {
	for (const [rel, content] of Object.entries(files)) {
		const target = join(root, ...rel.split('/'));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
};

export const writePackages = (root: string, specs: PackageSpec[]): void => {
	for (const spec of specs) {
		const files: Record<string, string> = { [`${spec.dir}/package.json`]: `${JSON.stringify(spec.manifest, null, 2)}\n` };
		for (const [rel, content] of Object.entries(spec.files ?? {})) files[`${spec.dir}/${rel}`] = content;
		writeFiles(root, files);
	}
};

// ---- Independent walker over installed packages ----

export interface InstalledPackage {
	name: string;
	version: string;
	// POSIX path of the package directory relative to the tree root.
	rel: string;
	dir: string;
	manifest: Record<string, unknown>;
}

// Workspace directories declared by `<root>/package.json` `workspaces` (only `dir/*` globs and plain paths).
export const workspaceDirsOf = (root: string): string[] => {
	const path = join(root, 'package.json');
	if (!existsSync(path)) return [];
	const m = JSON.parse(readFileSync(path, 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
	const patterns = Array.isArray(m.workspaces) ? m.workspaces : m.workspaces?.packages ?? [];
	const dirs: string[] = [];
	for (const pattern of patterns) {
		if (pattern.endsWith('/*')) {
			const parent = join(root, pattern.slice(0, -2));
			if (!existsSync(parent)) continue;
			for (const entry of readdirSync(parent).sort()) {
				const d = join(parent, entry);
				if (lstatSync(d).isDirectory() && existsSync(join(d, 'package.json'))) dirs.push(d);
			}
		} else if (existsSync(join(root, pattern, 'package.json'))) {
			dirs.push(join(root, pattern));
		}
	}
	return dirs;
};

// Every real package directory (a directory directly under `node_modules/` or `node_modules/@scope/` holding a
// package.json) below `<root>/node_modules` and below each workspace's `node_modules`, at any nesting depth.
// Symlinks (workspace links) are not followed. Nested manifests inside a package (e.g. `dist/package.json`) are not
// packages and are never returned.
export const installedPackages = (root: string): InstalledPackage[] => {
	const out: InstalledPackage[] = [];
	const visitPackage = (dir: string): void => {
		const stats = lstatSync(dir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return;
		const pj = join(dir, 'package.json');
		if (existsSync(pj)) {
			const m = JSON.parse(readFileSync(pj, 'utf8')) as Record<string, unknown>;
			out.push({ name: String(m.name ?? ''), version: String(m.version ?? ''), rel: toPosix(relative(root, dir)), dir, manifest: m });
		}
		walkNodeModules(join(dir, 'node_modules'));
	};
	const walkNodeModules = (nm: string): void => {
		if (!existsSync(nm)) return;
		for (const entry of readdirSync(nm).sort()) {
			if (entry.startsWith('.')) continue;
			const p = join(nm, entry);
			if (entry.startsWith('@')) {
				if (!lstatSync(p).isDirectory()) continue;
				for (const scoped of readdirSync(p).sort()) visitPackage(join(p, scoped));
			} else {
				visitPackage(p);
			}
		}
	};
	walkNodeModules(join(root, 'node_modules'));
	for (const ws of workspaceDirsOf(root)) walkNodeModules(join(ws, 'node_modules'));
	return out;
};

export const keyOf = (name: string, version: string): string => `${name}@${version}`;

// Licence files at the root of a package directory: LICENSE*, LICENCE*, COPYING*, NOTICE* (any case), regular files.
export const licenceFileNames = (dir: string): string[] =>
	readdirSync(dir).sort().filter(f => /^(licen[cs]e|copying|notice)/i.test(f) && lstatSync(join(dir, f)).isFile());

// ---- yarn.lock (Berry) ----

export interface LockEntry {
	descriptors: string[];
	version: string;
	resolution: string;
	dependencies: Map<string, string>;
}

const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, '$1');

export const parseYarnLock = (text: string): LockEntry[] => {
	const entries: LockEntry[] = [];
	let current: LockEntry | null = null;
	let section = '';
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('#') || line.trim() === '') continue;
		if (!line.startsWith(' ')) {
			if (current) entries.push(current);
			const key = unquote(line.replace(/:\s*$/, ''));
			current = key === '__metadata' ? null : { descriptors: key.split(/,\s*/).map(unquote), version: '', resolution: '', dependencies: new Map() };
			section = '';
			continue;
		}
		if (!current) continue;
		const top = /^ {2}([^\s:]+):\s*(.*)$/.exec(line);
		if (top) {
			section = top[1];
			if (section === 'version') current.version = unquote(top[2]);
			if (section === 'resolution') current.resolution = unquote(top[2]);
			continue;
		}
		const dep = /^ {4}("[^"]+"|[^\s:]+):\s*(.+)$/.exec(line);
		if (dep && section === 'dependencies') current.dependencies.set(unquote(dep[1]), unquote(dep[2]));
	}
	if (current) entries.push(current);
	return entries;
};

// The package name of a resolution such as `@babel/traverse@npm:7.27.0` or `nanoid@patch:nanoid@npm%3A3.3.7#…`.
export const resolvedName = (resolution: string): string => resolution.slice(0, resolution.indexOf('@', resolution.startsWith('@') ? 1 : 0));

const stripNpm = (range: string): string => range.replace(/^npm:/, '');
const withProtocol = (range: string): string => /^[a-z]+:/.test(range) ? range : `npm:${range}`;

export interface ClosureNode {
	name: string;
	version: string;
	// Set for workspace packages: the workspace directory relative to the upstream tree root.
	workspace: string | null;
}

// The transitive `dependencies` closure of the workspace at `workspaceRel` (e.g. `packages/app-mobile`) in an upstream
// checkout, resolved through `<tree>/yarn.lock` and the root package.json `resolutions` (which yarn applies at
// resolution time, so lockfile `dependencies:` still show the requested range). Workspaces contribute their
// package.json `dependencies` (the lockfile merges devDependencies into a workspace entry); npm packages contribute
// their lockfile `dependencies` (optional dependencies included). peerDependencies are not followed. `link:` and
// `portal:` resolutions (local stand-ins such as upstream's empty package) are not third-party packages and are left
// out. The start workspace itself is not included.
export const dependencyClosure = (tree: string, workspaceRel: string): Map<string, ClosureNode> => {
	const entries = parseYarnLock(readFileSync(join(tree, 'yarn.lock'), 'utf8'));
	const byDescriptor = new Map<string, LockEntry>();
	for (const e of entries) for (const d of e.descriptors) byDescriptor.set(d, e);
	const rootManifest = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')) as { resolutions?: Record<string, string> };
	const resolutions = Object.entries(rootManifest.resolutions ?? {});
	const workspaceDeps = (rel: string): Map<string, string> => {
		const m = JSON.parse(readFileSync(join(tree, rel, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
		return new Map(Object.entries(m.dependencies ?? {}));
	};
	// yarn `resolutions` keys: `name`, `name@range` (with or without `npm:`), `parent/name`.
	const applyResolutions = (parent: string, name: string, range: string): string => {
		for (const [pattern, value] of resolutions) {
			const at = pattern.lastIndexOf('@');
			const patternName = at > 0 ? pattern.slice(0, at) : pattern;
			const patternRange = at > 0 ? pattern.slice(at + 1) : null;
			const matchesName = patternName === name || patternName === `${parent}/${name}`;
			if (matchesName && (patternRange === null || stripNpm(patternRange) === stripNpm(range))) return value;
		}
		return range;
	};
	const lookup = (name: string, range: string): LockEntry => {
		const descriptor = `${name}@${withProtocol(range)}`;
		const exact = byDescriptor.get(descriptor);
		if (exact) return exact;
		// Descriptors bound to a locator (patch:/link: from `resolutions`) carry a `::locator=…` suffix in the key.
		const bound = [...byDescriptor.entries()].find(([d]) => d.startsWith(`${descriptor}::`));
		assert.ok(bound, `closure: ${descriptor} has no entry in ${join(tree, 'yarn.lock')}`);
		return bound[1];
	};
	const closure = new Map<string, ClosureNode>();
	const queue: [string, string, string][] = [...workspaceDeps(workspaceRel)].map(([n, r]) => [workspaceRel, n, r]);
	const seen = new Set<string>();
	while (queue.length > 0) {
		const [parent, name, requested] = queue.shift() as [string, string, string];
		const range = applyResolutions(parent, name, requested);
		const descriptor = `${name}@${withProtocol(range)}`;
		if (seen.has(descriptor)) continue;
		seen.add(descriptor);
		const entry = lookup(name, range);
		if (/@(link|portal):/.test(entry.resolution)) continue;
		const ws = /@workspace:(.+)$/.exec(entry.resolution);
		if (ws) {
			const rel = ws[1];
			const m = JSON.parse(readFileSync(join(tree, rel, 'package.json'), 'utf8')) as { version?: string };
			const node: ClosureNode = { name, version: m.version ?? entry.version, workspace: rel };
			if (!closure.has(keyOf(name, node.version))) {
				closure.set(keyOf(name, node.version), node);
				queue.push(...[...workspaceDeps(rel)].map(([n, r]): [string, string, string] => [name, n, r]));
			}
		} else {
			// The real package name comes from the resolution: an npm alias (`string-width-cjs: npm:string-width@^4`)
			// installs `string-width` under another directory name.
			const real = resolvedName(entry.resolution);
			if (!closure.has(keyOf(real, entry.version))) closure.set(keyOf(real, entry.version), { name: real, version: entry.version, workspace: null });
			queue.push(...[...entry.dependencies].map(([n, r]): [string, string, string] => [real, n, r]));
		}
	}
	return closure;
};

// ---- third-party-notices.txt (format contract: docs/test-plans/M1-S9.md §Notices format) ----

export interface NoticeEntry {
	name: string;
	version: string;
	license: string;
	// Everything after the `License:` line up to the next entry.
	body: string;
}

const packageLine = /^Package: (@?[^@\s]+)@(\S+)$/;

// Entries keyed by `name@version`. Throws (fails the test) on a malformed entry or a duplicate key.
export const parseNotices = (text: string): Map<string, NoticeEntry> => {
	const entries = new Map<string, NoticeEntry>();
	const lines = text.split(/\r?\n/);
	let current: { name: string; version: string; license: string | null; body: string[] } | null = null;
	const flush = (): void => {
		if (!current) return;
		assert.ok(current.license !== null, `third-party-notices.txt: the entry ${keyOf(current.name, current.version)} has no "License:" line right after its "Package:" line`);
		const key = keyOf(current.name, current.version);
		assert.ok(!entries.has(key), `third-party-notices.txt lists ${key} more than once`);
		entries.set(key, { name: current.name, version: current.version, license: current.license, body: current.body.join('\n') });
	};
	for (const line of lines) {
		const m = packageLine.exec(line);
		if (m) {
			flush();
			current = { name: m[1], version: m[2], license: null, body: [] };
			continue;
		}
		if (!current) continue;
		if (current.license === null) {
			if (line.trim() === '') continue;
			const lic = /^License: (.+)$/.exec(line);
			assert.ok(lic, `third-party-notices.txt: expected "License: …" after "Package: ${keyOf(current.name, current.version)}", got ${JSON.stringify(line)}`);
			current.license = lic[1].trim();
			continue;
		}
		current.body.push(line);
	}
	flush();
	return entries;
};

// Notice entries of a package name, whatever the version.
export const noticesNamed = (notices: Map<string, NoticeEntry>, name: string): NoticeEntry[] =>
	[...notices.values()].filter(e => e.name === name);

// Line endings, a BOM and trailing whitespace are not part of a licence text's content.
const normalizeText = (s: string): string => s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();

// The body must contain the licence file's full text.
export const bodyHasText = (entry: NoticeEntry, text: string): boolean => normalizeText(entry.body).includes(normalizeText(text));

// ---- Coverage of a real upstream tree (M1-AC29 integration: the S1 tree on the Pi, T90 in CI) ----

// Banner text in the bundle's *.LICENSE.txt extracts at web.commit → the package it identifies. A marker that is not
// present is not required; at least one must be (otherwise the banner half of the check would run on nothing).
export const bannerMarkers: [RegExp, string][] = [
	[/^\s*object-assign\s*$/m, 'object-assign'],
	[/Determine if an object is a Buffer/, 'is-buffer'],
	[/The buffer module from node\.js, for the browser/, 'buffer'],
	[/\breact-dom(?:-client)?\.production(?:\.min)?\.js\b/, 'react-dom'],
	[/\breact-is\.production(?:\.min)?\.js\b/, 'react-is'],
	[/(?:^|[\s*])react(?:-jsx-runtime)?\.production(?:\.min)?\.js\b/m, 'react'],
	[/\breact-refresh-runtime\.production(?:\.min)?\.js\b/, 'react-refresh'],
	[/\bscheduler\.production(?:\.min)?\.js\b/, 'scheduler'],
	[/\buse-sync-external-store-shim\b/, 'use-sync-external-store'],
];

export interface ExceptionEntry {
	name?: unknown;
	version?: unknown;
	noticeText?: unknown;
}

export interface CoverageResult {
	problems: string[];
	closureSize: number;
	notInstalled: string[];
	bannerPackages: string[];
}

// Checks a third-party-notices.txt against an upstream tree after `yarn install` and its built dist, independently of
// the production code: every installed package of the app-mobile `dependencies` closure has an entry with the full
// text of its licence file(s) (or its exception's noticeText); upstream workspaces without a licence file are listed
// once as AGPL-3.0-or-later with a source.html pointer; every package a banner identifies is listed. Closure packages
// that are not installed (platform-specific optional packages) cannot be in the bundle and are only reported.
export const noticesCoverage = (noticesText: string, tree: string, dist: string, exceptionsPath: string): CoverageResult => {
	const parsed = parseNotices(noticesText);
	const closure = dependencyClosure(tree, 'packages/app-mobile');
	const installed = new Map<string, InstalledPackage[]>();
	for (const p of installedPackages(tree)) {
		const k = keyOf(p.name, p.version);
		installed.set(k, [...(installed.get(k) ?? []), p]);
	}
	const list = JSON.parse(readFileSync(exceptionsPath, 'utf8')) as { exceptions?: ExceptionEntry[] };
	const exceptions = new Map((list.exceptions ?? []).map(e => [`${String(e.name)}@${String(e.version)}`, e]));
	const problems: string[] = [];
	const notInstalled: string[] = [];

	const checkInstalled = (key: string, copies: InstalledPackage[], entry: NoticeEntry): void => {
		const withFiles = copies.find(c => licenceFileNames(c.dir).length > 0);
		if (withFiles) {
			for (const f of licenceFileNames(withFiles.dir)) {
				if (!bodyHasText(entry, readFileSync(join(withFiles.dir, f), 'utf8'))) problems.push(`${key}: the entry lacks the full text of ${withFiles.rel}/${f}`);
			}
			return;
		}
		const exc = exceptions.get(key);
		if (!exc || typeof exc.noticeText !== 'string' || exc.noticeText.trim() === '') problems.push(`${key}: no licence file installed (${copies[0].rel}) and no exception with a noticeText`);
		else if (!entry.body.includes(exc.noticeText.trim())) problems.push(`${key}: the entry lacks its exception's noticeText`);
	};

	for (const [key, node] of closure) {
		if (node.workspace) {
			const entries = noticesNamed(parsed, node.name);
			if (entries.length !== 1) {
				problems.push(`${node.name} (upstream workspace ${node.workspace}): expected exactly one entry, found ${entries.length}`);
				continue;
			}
			const dir = join(tree, node.workspace);
			const files = licenceFileNames(dir);
			if (files.length > 0) {
				for (const f of files) if (!bodyHasText(entries[0], readFileSync(join(dir, f), 'utf8'))) problems.push(`${node.name}: the entry lacks the full text of ${node.workspace}/${f}`);
			} else {
				if (entries[0].license !== 'AGPL-3.0-or-later') problems.push(`${node.name}: an upstream workspace without its own licence file is listed as AGPL-3.0-or-later, found "${entries[0].license}"`);
				if (!entries[0].body.includes('source.html')) problems.push(`${node.name}: the entry must point at source.html`);
			}
			continue;
		}
		const copies = installed.get(key);
		if (!copies) {
			notInstalled.push(key);
			continue;
		}
		const entry = parsed.get(key);
		if (!entry) {
			problems.push(`${key}: missing (in the app-mobile dependencies closure, installed at ${copies[0].rel})`);
			continue;
		}
		checkInstalled(key, copies, entry);
	}

	const banners = readdirSync(dist).filter(f => f.endsWith('.LICENSE.txt')).map(f => readFileSync(join(dist, f), 'utf8')).join('\n');
	const bannerPackages = bannerMarkers.filter(([re]) => re.test(banners)).map(([, name]) => name);
	if (bannerPackages.length === 0) problems.push(`no known banner found in ${dist}/*.LICENSE.txt; the banner half of the check would be vacuous (review bannerMarkers on a pin bump)`);
	for (const name of bannerPackages) {
		const entries = noticesNamed(parsed, name).filter(e => installed.has(keyOf(e.name, e.version)));
		if (entries.length === 0) {
			problems.push(`${name}: named in a bundle *.LICENSE.txt banner but has no entry for an installed version`);
			continue;
		}
		for (const e of entries) checkInstalled(keyOf(e.name, e.version), installed.get(keyOf(e.name, e.version)) ?? [], e);
	}
	return { problems, closureSize: closure.size, notInstalled, bannerPackages };
};

// ---- M1-AC29 fixture: a synthetic upstream tree (layout of an upstream checkout after `yarn install`,
// nmHoistingLimits: workspaces). Our own manifests and texts; nothing from upstream. ----

export const fixtureLicenceText = (id: string): string => `Fixture licence text ${id} (Notestead M1-S9 synthetic package).\nPermission is granted for test purposes only.\n`;

const fixtureLock = (extraAppDeps: [string, string][], extraEntries: string[]): string => {
	const appDeps: [string, string][] = [
		['"@joplin/fork-x"', '"npm:^1.0.0"'], ['"@joplin/lib"', '"npm:~3.7"'], ['copying-pkg', '"npm:1.0.0"'],
		['dev-only', '"npm:1.0.0"'], ['direct-mit', '"npm:1.0.0"'], ['notice-pkg', '"npm:^2.0.0"'], ['two-versions', '"npm:^1.0.0"'], ...extraAppDeps,
	];
	const entry = (key: string, version: string, resolution: string, deps: [string, string][] = [], soft = false): string => [
		`"${key}":`, `  version: ${version}`, `  resolution: "${resolution}"`,
		...(deps.length > 0 ? ['  dependencies:', ...deps.map(([n, r]) => `    ${n}: ${r}`)] : []),
		...(soft ? ['  languageName: unknown', '  linkType: soft'] : ['  checksum: 10c0/0000', '  languageName: node', '  linkType: hard']), '',
	].join('\n');
	return [
		'# This file is generated by running "yarn install" inside your project.',
		'# Manual changes might be lost - proceed with caution!',
		'',
		'# M1-S9 TEST FIXTURE: synthetic upstream lockfile for the notices seam; never installed.',
		'',
		'__metadata:', '  version: 8', '  cacheKey: 10c0', '',
		entry('@joplin/app-desktop@workspace:packages/app-desktop', '0.0.0-use.local', '@joplin/app-desktop@workspace:packages/app-desktop', [['desktop-only', '"npm:1.0.0"']], true),
		entry('@joplin/app-mobile@workspace:packages/app-mobile', '0.0.0-use.local', '@joplin/app-mobile@workspace:packages/app-mobile', appDeps, true),
		entry('@joplin/fork-x@npm:^1.0.0, @joplin/fork-x@workspace:packages/fork-x', '0.0.0-use.local', '@joplin/fork-x@workspace:packages/fork-x', [], true),
		entry('@joplin/lib@npm:~3.7, @joplin/lib@workspace:packages/lib', '0.0.0-use.local', '@joplin/lib@workspace:packages/lib', [['lib-dep', '"npm:^3.0.0"'], ['two-versions', '"npm:^2.0.0"']], true),
		entry('@scope/scoped-dep@npm:1.0.0', '1.0.0', '@scope/scoped-dep@npm:1.0.0'),
		entry('banner-only-pkg@npm:1.4.1', '1.4.1', 'banner-only-pkg@npm:1.4.1'),
		entry('copying-pkg@npm:1.0.0', '1.0.0', 'copying-pkg@npm:1.0.0'),
		entry('deep-dep@npm:^1.0.0', '1.0.0', 'deep-dep@npm:1.0.0'),
		entry('desktop-only@npm:1.0.0', '1.0.0', 'desktop-only@npm:1.0.0'),
		entry('dev-only@npm:1.0.0', '1.0.0', 'dev-only@npm:1.0.0'),
		entry('direct-mit@npm:1.0.0', '1.0.0', 'direct-mit@npm:1.0.0', [['transitive-only', '"npm:~0.3.0"']]),
		entry('lib-dep@npm:^3.0.0', '3.1.0', 'lib-dep@npm:3.1.0', [['deep-dep', '"npm:^1.0.0"']]),
		entry('notice-pkg@npm:^2.0.0', '2.2.0', 'notice-pkg@npm:2.2.0', [['"@scope/scoped-dep"', '"npm:1.0.0"']]),
		entry('root@workspace:.', '0.0.0-use.local', 'root@workspace:.', [['banner-only-pkg', '"npm:1.4.1"']], true),
		entry('transitive-only@npm:~0.3.0', '0.3.0', 'transitive-only@npm:0.3.0'),
		entry('two-versions@npm:^1.0.0', '1.2.0', 'two-versions@npm:1.2.0'),
		entry('two-versions@npm:^2.0.0', '2.0.1', 'two-versions@npm:2.0.1'),
		...extraEntries,
	].join('\n');
};

export const mit = { license: 'MIT' };
const basePackages: PackageSpec[] = [
	{ dir: 'packages/app-mobile/node_modules/direct-mit', manifest: manifest('direct-mit', '1.0.0', mit), files: { LICENSE: fixtureLicenceText('direct-mit') } },
	{ dir: 'packages/app-mobile/node_modules/transitive-only', manifest: manifest('transitive-only', '0.3.0', mit), files: { license: fixtureLicenceText('transitive-only (lower-case file name)') } },
	{ dir: 'packages/app-mobile/node_modules/notice-pkg', manifest: manifest('notice-pkg', '2.2.0', { license: 'Apache-2.0' }), files: { 'LICENSE.md': fixtureLicenceText('notice-pkg LICENSE.md'), NOTICE: fixtureLicenceText('notice-pkg NOTICE') } },
	{ dir: 'packages/app-mobile/node_modules/@scope/scoped-dep', manifest: manifest('@scope/scoped-dep', '1.0.0', { license: 'ISC' }), files: { LICENSE: fixtureLicenceText('@scope/scoped-dep') } },
	{ dir: 'packages/app-mobile/node_modules/copying-pkg', manifest: manifest('copying-pkg', '1.0.0', { license: 'LGPL-3.0-or-later' }), files: { COPYING: fixtureLicenceText('copying-pkg COPYING') } },
	{ dir: 'packages/app-mobile/node_modules/two-versions', manifest: manifest('two-versions', '1.2.0', mit), files: { LICENSE: fixtureLicenceText('two-versions v1') } },
	// Bundled by the build (as webpack injects a polyfill) but in no app-mobile dependency list: a root devDependency.
	{ dir: 'node_modules/banner-only-pkg', manifest: manifest('banner-only-pkg', '1.4.1', mit), files: { LICENSE: fixtureLicenceText('banner-only-pkg') } },
	{ dir: 'packages/app-mobile/node_modules/dev-only', manifest: manifest('dev-only', '1.0.0', mit), files: { LICENSE: fixtureLicenceText('dev-only') } },
	{ dir: 'packages/lib/node_modules/lib-dep', manifest: manifest('lib-dep', '3.1.0', { license: 'BSD-3-Clause' }), files: { 'LICENCE.txt': fixtureLicenceText('lib-dep (British spelling)') } },
	{ dir: 'packages/lib/node_modules/two-versions', manifest: manifest('two-versions', '2.0.1', mit), files: { LICENSE: fixtureLicenceText('two-versions v2') } },
	{ dir: 'node_modules/deep-dep', manifest: manifest('deep-dep', '1.0.0', mit), files: { 'LICENSE-MIT': fixtureLicenceText('deep-dep (root node_modules)') } },
	{ dir: 'packages/app-desktop/node_modules/desktop-only', manifest: manifest('desktop-only', '1.0.0', mit), files: { LICENSE: fixtureLicenceText('desktop-only') } },
];

const workspaceFiles = (extraAppDeps: Record<string, string>): Record<string, string> => ({
	'package.json': `${JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'], devDependencies: { 'banner-only-pkg': '1.4.1' } }, null, 2)}\n`,
	'packages/app-mobile/package.json': `${JSON.stringify({
		name: '@joplin/app-mobile', version: '3.7.0', license: 'AGPL-3.0-or-later',
		dependencies: { '@joplin/fork-x': '^1.0.0', '@joplin/lib': '~3.7', 'copying-pkg': '1.0.0', 'direct-mit': '1.0.0', 'notice-pkg': '^2.0.0', 'two-versions': '^1.0.0', ...extraAppDeps },
		devDependencies: { 'dev-only': '1.0.0' },
	}, null, 2)}\n`,
	'packages/lib/package.json': `${JSON.stringify({ name: '@joplin/lib', version: '3.7.3', license: 'AGPL-3.0-or-later', dependencies: { 'lib-dep': '^3.0.0', 'two-versions': '^2.0.0' } }, null, 2)}\n`,
	'packages/fork-x/package.json': `${JSON.stringify({ name: '@joplin/fork-x', version: '1.0.5', license: 'MIT' }, null, 2)}\n`,
	'packages/fork-x/LICENSE': fixtureLicenceText('@joplin/fork-x (upstream fork with its own licence)'),
	'packages/app-desktop/package.json': `${JSON.stringify({ name: '@joplin/app-desktop', version: '3.7.0', license: 'AGPL-3.0-or-later', dependencies: { 'desktop-only': '1.0.0' } }, null, 2)}\n`,
});

export interface UpstreamFixtureExtra {
	appDeps?: Record<string, string>;
	lockEntries?: string[];
	packages?: PackageSpec[];
}

// Writes the synthetic upstream tree into the (new, empty) directory `root`.
export const writeUpstreamFixture = (root: string, extra: UpstreamFixtureExtra = {}): void => {
	const appDeps = extra.appDeps ?? {};
	writeFiles(root, workspaceFiles(appDeps));
	writeFiles(root, { 'yarn.lock': fixtureLock(Object.entries(appDeps).map(([n, r]) => [n, `"npm:${r}"`]), extra.lockEntries ?? []) });
	writePackages(root, [...basePackages, ...(extra.packages ?? [])]);
	// Workspace links, as yarn's node-modules linker creates them.
	mkdirSync(join(root, 'packages/app-mobile/node_modules/@joplin'), { recursive: true });
	symlinkSync('../../../lib', join(root, 'packages/app-mobile/node_modules/@joplin/lib'));
	symlinkSync('../../../fork-x', join(root, 'packages/app-mobile/node_modules/@joplin/fork-x'));
};

