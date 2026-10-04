// M1-AC29 (as amended: ADR-0010 notices precedence, ADR-0009 A9): third-party-notices.txt.
// - `corepack yarn workspace web-build notices <upstream-tree> --bundle <dist> --out <file> [--exceptions <file>]`
//   (the seam `build` uses) writes the notices for the transitive `dependencies` closure of upstream's
//   packages/app-mobile (resolved from the tree's yarn.lock) plus every package a bundle *.LICENSE.txt banner names,
//   with each package's full licence file text, or the standard SPDX text for a usable declared licence when the
//   package ships no file; anything else without a licence file fails unless excepted.
// - `overlay` links the file from source.html (next to the *.LICENSE.txt links) and `verify` fails without it.
// Fixtures: a synthetic upstream tree (our own manifests and texts, generated at test time) and F2 for verify.
// Test plan: docs/test-plans/M1-S9.md.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, describeRun, ensureInstalled, makeTempDir, removeDir, yarn,
} from '../support/repo.mts';
import type { RunOptions, RunResult } from '../support/repo.mts';
import {
	bodyHasText, dependencyClosure, fixtureLicenceText, hasPhrase, manifest, noticesNamed, parseNotices, writeFiles, writeUpstreamFixture,
} from '../support/licenses.mts';
import type { NoticeEntry, UpstreamFixtureExtra } from '../support/licenses.mts';
import {
	attempt, materialize, readTree, requireWorkspaceScript, settled, syntheticBundle, upstreamPublicBundle, writeTree,
} from '../support/webBundle.mts';
import type { Attempt, Tree } from '../support/webBundle.mts';

const story = 'm1-s9';
const minute = 60_000;
const noticesName = 'third-party-notices.txt';
const noticesHref = /href\s*=\s*["'](?:\.\/)?third-party-notices\.txt["']/;

const webBuild = (label: string, script: string, args: string[], opts: RunOptions = {}): RunResult => {
	ensureInstalled(story);
	requireWorkspaceScript(script, 'docs/test-plans/M1-S9.md §Command contracts');
	return yarn(story, label, ['workspace', 'web-build', script, ...args], { timeoutMs: 10 * minute, ...opts });
};

const temps: string[] = [];
after(() => temps.forEach(removeDir));
const tempDir = (prefix: string): string => {
	const dir = makeTempDir(`m1s9-${prefix}`);
	temps.push(dir);
	return dir;
};

const lineWith = (r: RunResult, needles: string[]): boolean => r.output.split('\n').some(line => needles.every(n => line.includes(n)));

const lockEntry = (name: string, version: string): string =>
	`"${name}@npm:${version}":\n  version: ${version}\n  resolution: "${name}@npm:${version}"\n  checksum: 10c0/0000\n  languageName: node\n  linkType: hard\n`;

// Distinctive phrases of the standard SPDX texts (short quotations, enough to tell the texts apart).
const mitPhrases = ['Permission is hereby granted, free of charge, to any person obtaining a copy', 'THE SOFTWARE IS PROVIDED "AS IS"'];
const apachePhrases = ['Apache License', 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'];
const iscPhrase = 'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted';

const text = fixtureLicenceText;

// A fresh synthetic upstream tree (tests/acceptance/support/licenses.mts); returns its root.
const upstreamTree = (prefix: string, extra: UpstreamFixtureExtra = {}): string => {
	const root = tempDir(prefix);
	writeUpstreamFixture(root, extra);
	return root;
};

// A bundle dir whose *.LICENSE.txt banner names a package that is installed but outside the dependencies closure
// (the object-assign banner form at web.commit: the package name on the first comment line).
const bannerBundle = (): string => {
	const dir = tempDir('bundle');
	writeFiles(dir, {
		'app.bundle.js': '/*! For license information please see app.bundle.js.LICENSE.txt */\n',
		'app.bundle.js.LICENSE.txt': '/*\n  banner-only-pkg\n  (c) Fixture Author\n  @license MIT\n  */\n',
	});
	return dir;
};

const exceptionsFile = (dir: string, exceptions: Record<string, unknown>[]): string => {
	const path = join(dir, 'license-exceptions.json');
	writeFileSync(path, `${JSON.stringify({ exceptions }, null, 2)}\n`);
	return path;
};

const notices = (label: string, tree: string, out: string, exceptions: string): RunResult =>
	webBuild(label, 'notices', [tree, '--bundle', bannerBundle(), '--out', out, '--exceptions', exceptions]);

describe('M1-AC29 notices seam on a synthetic upstream tree', () => {
	it('M1-S9-T400 positive: the closure, the banner package and the workspaces are covered with their full licence texts', () => {
		const tree = upstreamTree('notices-ok');
		const out = join(tempDir('notices-ok-out'), noticesName);
		const r = notices('T400-notices', tree, out, exceptionsFile(tempDir('exc-empty'), []));
		assertExitZero(r);
		assert.ok(existsSync(out), `--out must be written. ${describeRun(r)}`);
		const parsed = parseNotices(readFileSync(out, 'utf8'));

		// The reference closure (the test's own yarn.lock walk) and what it must not contain.
		const closure = dependencyClosure(tree, 'packages/app-mobile');
		assert.deepEqual([...closure.keys()].sort(), [
			'@joplin/fork-x@1.0.5', '@joplin/lib@3.7.3', '@scope/scoped-dep@1.0.0', 'copying-pkg@1.0.0', 'deep-dep@1.0.0', 'direct-mit@1.0.0',
			'lib-dep@3.1.0', 'notice-pkg@2.2.0', 'transitive-only@0.3.0', 'two-versions@1.2.0', 'two-versions@2.0.1',
		], 'fixture sanity: the reference closure (devDependencies and other workspaces excluded; banner-only-pkg, a root devDependency, is reachable only through the banner)');

		const expectText: Record<string, string[]> = {
			'direct-mit@1.0.0': [text('direct-mit')],
			'transitive-only@0.3.0': [text('transitive-only (lower-case file name)')],
			'notice-pkg@2.2.0': [text('notice-pkg LICENSE.md'), text('notice-pkg NOTICE')],
			'@scope/scoped-dep@1.0.0': [text('@scope/scoped-dep')],
			'copying-pkg@1.0.0': [text('copying-pkg COPYING')],
			'two-versions@1.2.0': [text('two-versions v1')],
			'two-versions@2.0.1': [text('two-versions v2')],
			'lib-dep@3.1.0': [text('lib-dep (British spelling)')],
			'deep-dep@1.0.0': [text('deep-dep (root node_modules)')],
			'@joplin/fork-x@1.0.5': [text('@joplin/fork-x (upstream fork with its own licence)')],
			'banner-only-pkg@1.4.1': [text('banner-only-pkg')],
		};
		const declared: Record<string, string> = {
			'direct-mit@1.0.0': 'MIT', 'notice-pkg@2.2.0': 'Apache-2.0', '@scope/scoped-dep@1.0.0': 'ISC', 'copying-pkg@1.0.0': 'LGPL-3.0-or-later',
			'lib-dep@3.1.0': 'BSD-3-Clause', 'two-versions@1.2.0': 'MIT', 'two-versions@2.0.1': 'MIT',
		};
		for (const [key, texts] of Object.entries(expectText)) {
			const entry = parsed.get(key);
			assert.ok(entry, `${noticesName} must have an entry "Package: ${key}" (entries: ${[...parsed.keys()].join(', ')})`);
			for (const t of texts) assert.ok(bodyHasText(entry, t), `${key}: the entry must contain the full text of its licence file(s): ${JSON.stringify(t.split('\n')[0])}`);
			if (declared[key]) assert.equal(entry.license, declared[key], `${key}: "License:" gives the declared licence`);
		}
		assert.ok(!bodyHasText(parsed.get('two-versions@1.2.0') ?? { name: '', version: '', license: '', body: '' }, text('two-versions v2')),
			'two-versions@1.2.0 must carry its own installed copy\'s text, not the 2.0.1 copy\'s');

		// Upstream's own workspace without a licence file: listed once, AGPL-3.0-or-later, pointing at source.html.
		const lib = noticesNamed(parsed, '@joplin/lib');
		assert.equal(lib.length, 1, '@joplin/lib is listed exactly once');
		assert.equal(lib[0].license, 'AGPL-3.0-or-later', '@joplin/lib is listed as AGPL-3.0-or-later');
		assert.ok(lib[0].body.includes('source.html'), '@joplin/lib points at source.html for its source and licence');
	});

	it('M1-S9-T401 (AC NEG) a package with no licence file, no licence field and no exception fails, naming it and its version; no file is written', () => {
		const tree = upstreamTree('notices-nofile', {
			appDeps: { 'no-licence-file': '0.1.0' },
			lockEntries: [lockEntry('no-licence-file', '0.1.0')],
			packages: [{ dir: 'packages/app-mobile/node_modules/no-licence-file', manifest: manifest('no-licence-file', '0.1.0'), files: { 'README.md': '# no-licence-file (fixture)\n' } }],
		});
		const out = join(tempDir('notices-nofile-out'), noticesName);
		const r = notices('T401-notices-no-file', tree, out, exceptionsFile(tempDir('exc-empty'), []));
		assertExitNonZero(r);
		assert.ok(lineWith(r, ['no-licence-file', '0.1.0']), `the failure names the package and its version on one line. ${describeRun(r)}`);
		assert.ok(!existsSync(out), `${noticesName} must not be written when the step fails`);
	});

	// ADR-0010 amendment (F2): no licence file but a usable declared licence → the standard SPDX text, marked as such.
	it('M1-S9-T402 positive control (F2): packages that declare a usable licence but ship no file get the standard SPDX text, a marker line and their declared author/repository', () => {
		const pkgs: { name: string; version: string; fields: Record<string, unknown> }[] = [
			{ name: 'declared-no-file', version: '0.2.0', fields: { license: 'MIT', author: 'Fixture Author <author@example.invalid>', repository: 'https://example.invalid/declared-no-file.git' } },
			{ name: 'declared-or-no-file', version: '0.4.0', fields: { license: '(MIT OR Apache-2.0)', author: { name: 'Fixture Org' } } },
			{ name: 'legacy-no-file', version: '0.5.0', fields: { licenses: [{ type: 'ISC', url: 'https://example.invalid/LICENSE' }] } },
		];
		const tree = upstreamTree('notices-declared-nofile', {
			appDeps: Object.fromEntries(pkgs.map(p => [p.name, p.version])),
			lockEntries: pkgs.map(p => lockEntry(p.name, p.version)),
			packages: pkgs.map(p => ({ dir: `packages/app-mobile/node_modules/${p.name}`, manifest: manifest(p.name, p.version, p.fields), files: { 'README.md': `# ${p.name} (fixture, no licence file)\n` } })),
		});
		const out = join(tempDir('notices-declared-out'), noticesName);
		const r = notices('T402-notices-declared-no-file', tree, out, exceptionsFile(tempDir('exc-empty'), []));
		assertExitZero(r);
		const parsed = parseNotices(readFileSync(out, 'utf8'));
		const entry = (key: string): NoticeEntry => {
			const e = parsed.get(key);
			assert.ok(e, `${noticesName} lists ${key}`);
			return e;
		};

		const mitEntry = entry('declared-no-file@0.2.0');
		assert.equal(mitEntry.license, 'MIT', 'License: gives the declared licence');
		assert.ok(mitEntry.body.split('\n').some(l => l.trim() === 'Licence text: standard SPDX text for MIT; no licence file in the package'), `the entry has the marker line. Body: ${mitEntry.body.slice(0, 400)}`);
		for (const phrase of mitPhrases) assert.ok(hasPhrase(mitEntry.body, phrase), `the entry has the standard MIT text (${JSON.stringify(phrase)})`);
		assert.ok(mitEntry.body.includes('Fixture Author'), 'the entry gives the declared author');
		assert.ok(mitEntry.body.includes('https://example.invalid/declared-no-file.git'), 'the entry gives the declared repository');
		assert.match(mitEntry.body, /not declared/i, 'undeclared contributors are stated as "not declared"');

		const orEntry = entry('declared-or-no-file@0.4.0');
		assert.ok(orEntry.body.split('\n').some(l => /^Licence text: standard SPDX text for .*MIT.*Apache-2\.0.*; no licence file in the package$/.test(l.trim())), 'the marker line names the declared expression');
		for (const phrase of [...mitPhrases, ...apachePhrases]) assert.ok(hasPhrase(orEntry.body, phrase), `every ID of the expression gets its standard text (${JSON.stringify(phrase)})`);
		assert.ok(orEntry.body.includes('Fixture Org'), 'an author object is given by its name');

		const legacyEntry = entry('legacy-no-file@0.5.0');
		assert.ok(legacyEntry.body.split('\n').some(l => l.trim() === 'Licence text: standard SPDX text for ISC; no licence file in the package'), 'a legacy form derives the expression (ADR-0009 A9) for the fallback');
		assert.ok(hasPhrase(legacyEntry.body, iscPhrase), 'the entry has the standard ISC text');
	});

	it('M1-S9-T404 NEG: no licence file and no usable declared licence (UNLICENSED, SEE LICENSE IN, non-SPDX, LicenseRef) without an exception fails, naming each package and version', () => {
		const pkgs: { name: string; version: string; license: string }[] = [
			{ name: 'unlicensed-no-file', version: '1.0.0', license: 'UNLICENSED' },
			{ name: 'see-file-no-file', version: '1.1.0', license: 'SEE LICENSE IN LICENSE.txt' },
			{ name: 'non-spdx-no-file', version: '1.2.0', license: 'Apache 2' },
			{ name: 'licenseref-no-file', version: '1.3.0', license: 'LicenseRef-Fixture-Proprietary' },
		];
		const tree = upstreamTree('notices-unusable', {
			appDeps: Object.fromEntries(pkgs.map(p => [p.name, p.version])),
			lockEntries: pkgs.map(p => lockEntry(p.name, p.version)),
			packages: pkgs.map(p => ({ dir: `packages/app-mobile/node_modules/${p.name}`, manifest: manifest(p.name, p.version, { license: p.license }) })),
		});
		const out = join(tempDir('notices-unusable-out'), noticesName);
		const r = notices('T404-notices-unusable', tree, out, exceptionsFile(tempDir('exc-empty'), []));
		assertExitNonZero(r);
		const unnamed = pkgs.filter(p => !lineWith(r, [p.name, p.version])).map(p => `${p.name}@${p.version}`);
		assert.deepEqual(unnamed, [], `each package without a usable licence is named with its version on one line. ${describeRun(r)}`);
		assert.ok(!existsSync(out), `${noticesName} must not be written when the step fails`);
	});

	it('M1-S9-T403 positive control: the same package with a reviewed exception passes, and the entry uses the exception\'s text and reason', () => {
		const tree = upstreamTree('notices-excepted', {
			appDeps: { 'no-licence-file': '0.1.0' },
			lockEntries: [lockEntry('no-licence-file', '0.1.0')],
			packages: [{ dir: 'packages/app-mobile/node_modules/no-licence-file', manifest: manifest('no-licence-file', '0.1.0'), files: { 'README.md': '# no-licence-file (fixture)\n' } }],
		});
		const noticeText = 'MIT License (fixture). Copyright (c) Fixture Author. Text established from the fixture repository at tag v0.1.0.';
		const reason = 'M1-S9 fixture: the npm tarball ships no licence file; the text comes from the source repository';
		const exc = exceptionsFile(tempDir('exc-one'), [{ name: 'no-licence-file', version: '0.1.0', license: 'MIT', evidence: 'https://example.invalid/no-licence-file/blob/v0.1.0/LICENSE', reason, noticeText }]);
		const out = join(tempDir('notices-excepted-out'), noticesName);
		const r = notices('T403-notices-excepted', tree, out, exc);
		assertExitZero(r);
		const entry = parseNotices(readFileSync(out, 'utf8')).get('no-licence-file@0.1.0');
		assert.ok(entry, `${noticesName} lists no-licence-file@0.1.0`);
		assert.ok(entry.body.includes(noticeText), 'the entry contains the exception\'s noticeText');
		assert.ok(entry.body.includes(reason), 'the entry states the exception\'s reason');
	});
});

describe('M1-AC29 overlay links the notices and verify requires them', () => {
	const synthNotices = 'Third-party notices (M1-S9 fixture)\n\nPackage: fixture-pkg@1.0.0\nLicense: MIT\n\nFixture licence text.\n';
	let setup: Attempt<{ overlay: RunResult; overlaidTree: Tree }> | null = null;

	// F2 (upstream public files at web.commit + synthetic webpack outputs) with a notices file, then `overlay`.
	before(() => {
		setup = attempt(() => {
			const tree = upstreamPublicBundle();
			tree.set(noticesName, Buffer.from(synthNotices));
			const dir = materialize('m1s9-ac29-overlaid', tree);
			temps.push(dir);
			const overlay = webBuild('T410-overlay-F2-with-notices', 'overlay', [dir]);
			return { overlay, overlaidTree: overlay.code === 0 ? readTree(dir) : new Map<string, Buffer>() };
		});
	});

	const overlaidCopy = (label: string, edit: (tree: Tree) => void = () => undefined): string => {
		const { overlay, overlaidTree } = settled(setup);
		assert.equal(overlay.code, 0, `this test needs an overlaid bundle, but overlay failed. ${describeRun(overlay)}`);
		const copy: Tree = new Map(overlaidTree);
		edit(copy);
		const dir = tempDir(`ac29-${label}`);
		writeTree(dir, copy);
		return dir;
	};
	const verify = (label: string, dir: string): RunResult => {
		const upstream = process.env.JOPLIN_UPSTREAM_DIR ? ['--upstream', process.env.JOPLIN_UPSTREAM_DIR] : [];
		return webBuild(label, 'verify', [...upstream, dir]);
	};

	it('M1-S9-T410 source.html links third-party-notices.txt alongside the webpack *.LICENSE.txt extracts (F1 and F2)', () => {
		const { overlaidTree } = settled(setup);
		const f2Source = overlaidTree.get('source.html')?.toString('utf8') ?? '';
		assert.match(f2Source, noticesHref, 'F2: source.html must link ./third-party-notices.txt');
		const f1 = syntheticBundle();
		f1.set(noticesName, Buffer.from(synthNotices));
		const dir = materialize('m1s9-ac29-f1', f1);
		temps.push(dir);
		assertExitZero(webBuild('T410-overlay-F1-with-notices', 'overlay', [dir]));
		const source = readFileSync(join(dir, 'source.html'), 'utf8');
		assert.match(source, noticesHref, 'F1: source.html must link ./third-party-notices.txt');
		assert.match(source, /href\s*=\s*["'](?:\.\/)?app\.bundle\.js\.LICENSE\.txt["']/, 'F1: source.html still links the webpack LICENSE.txt extract');
		assert.ok(readFileSync(join(dir, noticesName), 'utf8') === synthNotices, 'overlay leaves third-party-notices.txt unchanged');
	});

	it('M1-S9-T411 positive control: the overlaid bundle with its notices passes verify', () => {
		assertExitZero(verify('T411-verify-with-notices', overlaidCopy('ok')));
	});

	it('M1-S9-T412 (AC NEG) the same bundle without third-party-notices.txt fails verify, naming the file', () => {
		const r = verify('T412-verify-no-notices', overlaidCopy('no-notices', t => t.delete(noticesName)));
		assertExitNonZero(r);
		assert.ok(r.output.includes(noticesName), `verify must name ${noticesName}. ${describeRun(r)}`);
	});

	it('M1-S9-T413 NEG: the notices present but not linked from source.html fails verify, naming source.html', () => {
		const r = verify('T413-verify-unlinked', overlaidCopy('unlinked', t => {
			const source = t.get('source.html')?.toString('utf8') ?? '';
			const edited = source.replace(new RegExp(noticesHref.source, 'g'), 'href="./moved-notices.txt"');
			assert.ok(edited !== source, 'overlay must link the notices from source.html (T410) before this NEG can remove the link');
			t.set('source.html', Buffer.from(edited));
		}));
		assertExitNonZero(r);
		assert.ok(r.output.includes('source.html'), `verify must name source.html. ${describeRun(r)}`);
	});
});
