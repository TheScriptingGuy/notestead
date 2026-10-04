// third-party-notices.txt for the web bundle (ADR-0010 and its amendment of 2026-10-04; M1-AC29). Generated from an
// upstream checkout at web.commit after the recipe's `yarn install`, and the built dist:
// - coverage: the transitive `dependencies` closure of upstream's packages/app-mobile, resolved through the tree's
//   yarn.lock and root `resolutions` (closure below), plus every installed package that a bundle `*.LICENSE.txt`
//   banner names (bannerPackages below). Closure packages that are not installed (platform-specific optional ones)
//   cannot be in the bundle and are skipped.
// - one entry per name@version, first matching rule (ADR-0010 amendment): (1) an upstream workspace without its own
//   licence file is AGPL-3.0-or-later with a pointer to source.html; (2) a package with licence files gets the full
//   text of each (LICENSE*, LICENCE*, COPYING*, NOTICE*, any case, at the package root); then a reviewed exception's
//   noticeText; (3) a usable declared licence gets the standard SPDX text with a marker line; anything else fails.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { installedPackages, packageKey } from './installedPackages.ts';
import type { InstalledPackage } from './installedPackages.ts';
import type { ExceptionList } from './licenseExceptions.ts';
import { parseLockfile } from './lockfile.ts';
import type { LockEntry } from './lockfile.ts';
import { declaredLicence, parseSpdx, spdxIds } from './spdx.ts';
import type { SpdxNode } from './spdx.ts';
import type { StandardTexts } from './spdxTexts.ts';

export const noticesFileName = 'third-party-notices.txt';
export const appWorkspace = 'packages/app-mobile';

const toPosix = (path: string): string => path.split(sep).join('/');
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const stringRecord = (value: unknown): Record<string, string> =>
	value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) : {};

// ---- The app-mobile dependency closure ----

export interface ClosureNode {
	name: string;
	version: string;
	// For an upstream workspace: its directory relative to the tree root (POSIX). null for npm packages.
	workspace: string | null;
}

const withProtocol = (range: string): string => /^[a-z][a-z0-9+.-]*:/i.test(range) ? range : `npm:${range}`;

interface ResolutionRule {
	name: string;
	parent: string | null;
	range: string | null;
	value: string;
}

// yarn `resolutions` keys: `name`, `name@range`, `parent/name` and `parent/name@range` (names may be scoped).
export const parseResolutionKey = (pattern: string, value: string): ResolutionRule => {
	const at = pattern.lastIndexOf('@');
	const hasRange = at > 0 && pattern[at - 1] !== '/';
	const path = hasRange ? pattern.slice(0, at) : pattern;
	const segments = path.split('/');
	const nameLength = segments.length >= 2 && segments[segments.length - 2].startsWith('@') ? 2 : 1;
	return {
		name: segments.slice(-nameLength).join('/'),
		parent: segments.length > nameLength ? segments.slice(0, -nameLength).join('/') : null,
		range: hasRange ? pattern.slice(at + 1) : null,
		value,
	};
};

// The transitive `dependencies` closure of the workspace `start` (default packages/app-mobile), keyed by
// name@version. Workspaces contribute their package.json `dependencies` (the lockfile merges their devDependencies);
// npm packages their lockfile `dependencies` (optional ones included). npm aliases are listed under the real package
// name; `link:`/`portal:` stand-ins are not packages. The start workspace itself is not included.
export const dependencyClosure = (tree: string, start = appWorkspace): Map<string, ClosureNode> => {
	const entries = parseLockfile(readFileSync(join(tree, 'yarn.lock'), 'utf8'));
	const byDescriptor = new Map<string, LockEntry>();
	const byUnboundDescriptor = new Map<string, LockEntry>();
	for (const entry of entries) {
		for (const descriptor of entry.descriptors) {
			byDescriptor.set(descriptor, entry);
			// Descriptors bound to a locator (patch:/link: from `resolutions`) carry a `::locator=…` suffix.
			const bound = descriptor.indexOf('::');
			if (bound > 0) byUnboundDescriptor.set(descriptor.slice(0, bound), entry);
		}
	}
	const rules = Object.entries(stringRecord(readJson(join(tree, 'package.json')).resolutions)).map(([k, v]) => parseResolutionKey(k, v));
	const resolve = (parent: string, name: string, range: string): string => {
		const rule = rules.find(r => r.name === name && (r.parent === null || r.parent === parent) && (r.range === null || withProtocol(r.range) === withProtocol(range)));
		return rule ? rule.value : range;
	};
	const workspaceManifest = (rel: string): Record<string, unknown> => readJson(join(tree, ...rel.split('/'), 'package.json'));

	const closure = new Map<string, ClosureNode>();
	const startManifest = workspaceManifest(start);
	const queue: [string, string, string][] = Object.entries(stringRecord(startManifest.dependencies)).map(([n, r]) => [String(startManifest.name ?? start), n, r]);
	const seen = new Set<string>();
	while (queue.length > 0) {
		const [parent, name, requested] = queue.shift() as [string, string, string];
		const descriptor = `${name}@${withProtocol(resolve(parent, name, requested))}`;
		if (seen.has(descriptor)) continue;
		seen.add(descriptor);
		const entry = byDescriptor.get(descriptor) ?? byUnboundDescriptor.get(descriptor);
		if (!entry) throw new Error(`${join(tree, 'yarn.lock')} has no entry for ${descriptor} (a dependency of ${parent}); is the tree installed at web.commit?`);
		if (/@(link|portal):/.test(entry.resolution)) continue;
		const workspace = /@workspace:(.+)$/.exec(entry.resolution);
		if (workspace) {
			const rel = workspace[1];
			const manifest = workspaceManifest(rel);
			const version = typeof manifest.version === 'string' ? manifest.version : entry.version;
			const key = packageKey(entry.name, version);
			if (!closure.has(key)) {
				closure.set(key, { name: entry.name, version, workspace: rel });
				queue.push(...Object.entries(stringRecord(manifest.dependencies)).map(([n, r]): [string, string, string] => [entry.name, n, r]));
			}
		} else {
			const key = packageKey(entry.name, entry.version);
			if (!closure.has(key)) closure.set(key, { name: entry.name, version: entry.version, workspace: null });
			queue.push(...Object.entries(entry.dependencies).map(([n, r]): [string, string, string] => [entry.name, n, r]));
		}
	}
	return closure;
};

// ---- Packages named in the bundle's *.LICENSE.txt banners ----

// Reviewed banner phrases that name no package or file (checked against the bundle at web.commit v3.7.21).
const bannerPhrases: [string, string][] = [
	['Determine if an object is a Buffer', 'is-buffer'],
	['The buffer module from node.js, for the browser', 'buffer'],
];
// Where a banner's file name (e.g. `react-dom-client.production.js`) sits inside the package that ships it.
const bannerFileDirs = ['', 'cjs', 'umd', 'dist', 'lib'];

export interface BannerResult {
	// Installed copies named by a banner.
	packages: InstalledPackage[];
	// The first line of each banner comment that names no installed package (reported for review on a pin bump).
	unresolved: string[];
}

const licenceTxtFiles = (dir: string): string[] => {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...licenceTxtFiles(path));
		else if (entry.isFile() && entry.name.endsWith('.LICENSE.txt')) found.push(path);
	}
	return found.sort();
};

export const bannerPackages = (bundle: string, installed: InstalledPackage[]): BannerResult => {
	const byName = new Map<string, InstalledPackage[]>();
	for (const p of installed) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
	const named = new Map<string, InstalledPackage>();
	const unresolved: string[] = [];
	for (const file of licenceTxtFiles(bundle)) {
		for (const comment of readFileSync(file, 'utf8').match(/\/\*[\s\S]*?\*\//g) ?? []) {
			const lines = comment.split('\n').map(line => line.replace(/^\s*\/\*+\s*!?\s?|\*\/\s*$|^\s*\*\s?/g, '').trim()).filter(line => line !== '');
			const found: InstalledPackage[] = [];
			if (lines.length > 0 && byName.has(lines[0])) found.push(...byName.get(lines[0]) ?? []);
			for (const [phrase, name] of bannerPhrases) if (comment.includes(phrase)) found.push(...byName.get(name) ?? []);
			// A line that is just a file name (`react-dom-client.production.js`): the packages that ship that file.
			for (const fileName of lines.filter(line => /^[\w@][\w@./-]*\.(?:js|cjs|mjs)$/.test(line) && !line.includes('..'))) {
				found.push(...installed.filter(p => bannerFileDirs.some(d => existsSync(join(p.dir, d, ...fileName.split('/'))))));
			}
			if (found.length === 0) unresolved.push(`${toPosix(relative(bundle, file))}: ${lines[0] ?? '(empty comment)'}`);
			for (const p of found) named.set(p.dir, p);
		}
	}
	return { packages: [...named.values()], unresolved };
};

// ---- Entries ----

// Licence files at the root of a package directory: LICENSE*, LICENCE*, COPYING*, NOTICE*, case-insensitively.
export const licenceFiles = (dir: string): string[] =>
	readdirSync(dir).sort().filter(f => /^(licen[cs]e|copying|notice)/i.test(f) && lstatSync(join(dir, f)).isFile());

const normalizeText = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const person = (value: unknown): string | null => {
	if (typeof value === 'string') return oneLine(value) || null;
	if (value === null || typeof value !== 'object') return null;
	const { name, email, url } = value as Record<string, unknown>;
	if (typeof name !== 'string' || name.trim() === '') return null;
	return oneLine([name, typeof email === 'string' ? `<${email}>` : '', typeof url === 'string' ? `(${url})` : ''].join(' '));
};

const repository = (value: unknown): string | null => {
	if (typeof value === 'string') return oneLine(value) || null;
	if (value === null || typeof value !== 'object') return null;
	const { url, directory } = value as Record<string, unknown>;
	if (typeof url !== 'string' || url.trim() === '') return null;
	return oneLine(typeof directory === 'string' ? `${url} (directory ${directory})` : url);
};

// The marker line of a standard-text entry (ADR-0010 amendment, rule 3).
export const fallbackMarker = (expression: string): string => `Licence text: standard SPDX text for ${expression}; no licence file in the package`;

const entryHeader = /^Package: (@?[^@\s]+)@(\S+)$/m;

const hasWithException = (node: SpdxNode): boolean =>
	node.type === 'licence' ? node.exception !== null : hasWithException(node.left) || hasWithException(node.right);

interface Entry {
	key: string;
	license: string;
	body: string[];
}

export interface NoticesInput {
	tree: string;
	bundle: string;
	exceptions: ExceptionList;
	exceptionsLabel: string;
	texts: StandardTexts;
}

export interface NoticesResult {
	text: string;
	entries: number;
	// One per package that cannot be given a notice, naming it and its version. Nothing may be written then.
	problems: string[];
	notes: string[];
}

export const generateNotices = (input: NoticesInput): NoticesResult => {
	const { tree, exceptions, texts } = input;
	const problems = [...input.exceptions.problems];
	const notes: string[] = [];
	const closure = dependencyClosure(tree);
	const installed = installedPackages(tree);
	const copies = new Map<string, InstalledPackage[]>();
	for (const p of installed) copies.set(packageKey(p.name, p.version), [...(copies.get(packageKey(p.name, p.version)) ?? []), p]);

	const entries = new Map<string, Entry>();
	const fileEntry = (key: string, license: string, dir: string, files: string[]): Entry => {
		const body: string[] = [];
		for (const file of files) {
			const text = normalizeText(readFileSync(join(dir, file), 'utf8'));
			if (entryHeader.test(text)) problems.push(`${key}: its licence file ${file} contains a line that looks like a "Package: name@version" entry header; review it before it can be listed`);
			body.push(`Licence file: ${file}`, '', text, '');
		}
		return { key, license, body };
	};

	const addPackage = (key: string, pkgs: InstalledPackage[]): void => {
		if (entries.has(key)) return;
		const pkg = pkgs.find(p => licenceFiles(p.dir).length > 0) ?? pkgs[0];
		const declared = declaredLicence(pkg.manifest);
		const files = licenceFiles(pkg.dir);
		if (files.length > 0) {
			entries.set(key, fileEntry(key, declared.expression ?? exceptions.entries.get(key)?.license ?? 'UNKNOWN', pkg.dir, files));
			return;
		}
		const exception = exceptions.entries.get(key);
		if (exception?.noticeText) {
			const text = normalizeText(exception.noticeText);
			if (entryHeader.test(text)) problems.push(`${key}: the noticeText of its exception contains a line that looks like a "Package: name@version" entry header`);
			entries.set(key, { key, license: exception.license, body: [
				`Licence text: from the reviewed exception list (${input.exceptionsLabel}); no licence file in the package`,
				`Declared licence: ${declared.expression ?? 'not declared'}`,
				`Evidence: ${oneLine(exception.evidence)}`,
				`Reason: ${oneLine(exception.reason)}`,
				'', text, '',
			] });
			return;
		}
		// "Usable": a valid SPDX expression without a WITH exception, and a standard text for every ID in it.
		const expression = declared.expression === null ? null : parseSpdx(declared.expression);
		const standard = expression === null || hasWithException(expression) ? null : [...new Set(spdxIds(expression))].map(id => [id, texts.text(id)] as const);
		if (declared.expression !== null && standard && standard.every(([, text]) => text !== null)) {
			const contributors = Array.isArray(pkg.manifest.contributors) ? pkg.manifest.contributors.map(person).filter(c => c !== null) : [person(pkg.manifest.contributors)].filter(c => c !== null);
			const body = [
				fallbackMarker(declared.expression),
				`Author: ${person(pkg.manifest.author) ?? 'not declared'}`,
				`Contributors: ${contributors.length > 0 ? contributors.join('; ') : 'not declared'}`,
				`Repository: ${repository(pkg.manifest.repository) ?? 'not declared'}`,
				'',
			];
			for (const [id, text] of standard) body.push(`Standard text of ${id} (${texts.source}):`, '', normalizeText(text ?? ''), '');
			entries.set(key, { key, license: declared.expression, body });
			return;
		}
		const why = exception ? `its exception in ${input.exceptionsLabel} has no noticeText` : `no exception with a noticeText in ${input.exceptionsLabel}`;
		problems.push(`${key} (${pkg.rel}): no licence file, no usable declared licence (${declared.expression === null ? 'none declared' : JSON.stringify(declared.expression)}), and ${why}`);
	};

	const notInstalled: string[] = [];
	for (const [key, node] of [...closure].sort(([a], [b]) => a.localeCompare(b))) {
		if (node.workspace) {
			const dir = join(tree, ...node.workspace.split('/'));
			const files = licenceFiles(dir);
			if (files.length > 0) {
				entries.set(key, fileEntry(key, declaredLicence(readJson(join(dir, 'package.json'))).expression ?? 'UNKNOWN', dir, files));
			} else {
				const declared = declaredLicence(readJson(join(dir, 'package.json'))).expression;
				entries.set(key, { key, license: 'AGPL-3.0-or-later', body: [
					`Part of upstream Joplin (${node.workspace}), which has no licence file of its own: it is covered by upstream's repository licence, AGPL-3.0-or-later.`,
					...(declared !== null && declared !== 'AGPL-3.0-or-later' ? [`(Its package.json declares ${JSON.stringify(declared)}; upstream's repository licence applies to directories without their own licence file.)`] : []),
					'Its complete source and the licence text are linked from source.html.',
					'',
				] });
			}
			continue;
		}
		const pkgs = copies.get(key);
		if (!pkgs) notInstalled.push(key);
		else addPackage(key, pkgs);
	}
	const banners = bannerPackages(input.bundle, installed);
	for (const pkg of banners.packages) addPackage(packageKey(pkg.name, pkg.version), copies.get(packageKey(pkg.name, pkg.version)) ?? [pkg]);

	if (notInstalled.length > 0) notes.push(`${notInstalled.length} closure package(s) are not installed in ${tree} (platform-specific optional packages; not in the bundle): ${notInstalled.join(', ')}`);
	if (banners.unresolved.length > 0) notes.push(`${banners.unresolved.length} banner comment(s) name no installed package (their text is in the *.LICENSE.txt files that source.html links): ${banners.unresolved.join(' | ')}`);

	const sorted = [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
	const separator = '='.repeat(80);
	const text = [
		'Third-party notices for the Notestead for Joplin (unofficial) web app',
		'',
		'This web app is the web build of upstream Joplin\'s packages/app-mobile, built unmodified from source (see',
		'source.html). Below is every third-party package it contains or may contain: the transitive dependencies of',
		'packages/app-mobile resolved from upstream\'s yarn.lock, and the packages named in the bundle\'s *.LICENSE.txt',
		'banners. Each entry gives the package, its declared licence and the full text of its licence file(s).',
		'Upstream Joplin packages without a licence file of their own are covered by upstream\'s AGPL-3.0-or-later',
		'licence; their source is linked from source.html. Packages that ship no licence file but declare a standard',
		`licence carry the standard SPDX text (from ${texts.source}), marked as such.`,
		'',
		...sorted.flatMap(e => [separator, `Package: ${e.key}`, `License: ${e.license}`, '', ...e.body]),
		separator,
		'',
	].join('\n');
	return { text, entries: sorted.length, problems, notes };
};

// Writes `out` only when every package has a notice; returns the result either way.
export const writeNotices = (input: NoticesInput, out: string): NoticesResult => {
	const result = generateNotices(input);
	if (result.problems.length > 0) return result;
	mkdirSync(dirname(out), { recursive: true });
	const temporary = `${out}.tmp-${process.pid}`;
	try {
		writeFileSync(temporary, result.text);
		renameSync(temporary, out);
	} finally {
		rmSync(temporary, { force: true });
	}
	return result;
};
