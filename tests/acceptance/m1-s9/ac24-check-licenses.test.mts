// M1-AC24: `corepack yarn check:licenses [--root <dir>] [--exceptions <file>] [--report <file>]` lists the declared
// licence of every installed package and exits 0 only when each licence (SPDX expression) is on ADR-0009's
// allow-list or covered by a reviewed exception (exact version, licence, evidence, reason).
// Fixture trees are synthetic (our own manifests, generated at test time). The real-tree tests run on this repo.
// Test plan: docs/test-plans/M1-S9.md.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, describeRun, ensureInstalled, makeTempDir, readJson, removeDir, repoRoot,
	yarnScript,
} from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';
import { installedPackages, keyOf, manifest, writeFiles, writePackages } from '../support/licenses.mts';
import type { PackageSpec } from '../support/licenses.mts';

const story = 'm1-s9';
const minute = 60_000;
const contract = 'docs/test-plans/M1-S9.md §Command contracts';
const defaultExceptions = join(repoRoot, 'packages', 'web-build', 'license-exceptions.json');

interface ReportPackage {
	name: string;
	version: string;
	path?: string;
	license: string | null;
	status: string;
}

interface Exception {
	name?: unknown;
	version?: unknown;
	license?: unknown;
	evidence?: unknown;
	reason?: unknown;
	noticeText?: unknown;
	prepublishBlocker?: unknown;
}

let installed = false;
const checkLicenses = (label: string, args: string[]): RunResult => {
	if (!installed) {
		ensureInstalled(story);
		installed = true;
	}
	return yarnScript(story, label, 'check:licenses', args, { timeoutMs: 5 * minute }, contract);
};

const temps: string[] = [];
after(() => temps.forEach(removeDir));

// One output line must mention the package (name@version) and the given licence text.
const lineWith = (r: RunResult, ...needles: (string | RegExp)[]): boolean =>
	r.output.split('\n').some(line => needles.every(n => typeof n === 'string' ? line.includes(n) : n.test(line)));

const assertLine = (r: RunResult, why: string, ...needles: (string | RegExp)[]): void => {
	assert.ok(lineWith(r, ...needles), `${why}: expected one output line containing all of ${needles.map(String).join(' , ')}. ${describeRun(r)}`);
};

const noLicenceMarker = /no licen[cs]e|missing|none|UNKNOWN/i;

// ---- Fixture trees (synthetic; a workspace with its own node_modules, as with nmHoistingLimits: workspaces) ----

const lic = (license: unknown): Record<string, unknown> => ({ license });

// Allowed by ADR-0009's allow-list, including SPDX expressions that must be evaluated (not string-matched).
const allowedSpecs: PackageSpec[] = [
	{ dir: 'node_modules/fx-mit', manifest: manifest('fx-mit', '1.0.0', lic('MIT')) },
	{ dir: 'node_modules/fx-isc', manifest: manifest('fx-isc', '1.0.1', lic('ISC')) },
	{ dir: 'node_modules/fx-bsd2', manifest: manifest('fx-bsd2', '1.0.2', lic('BSD-2-Clause')) },
	{ dir: 'node_modules/fx-bsd3', manifest: manifest('fx-bsd3', '1.0.3', lic('BSD-3-Clause')) },
	{ dir: 'node_modules/fx-apache', manifest: manifest('fx-apache', '1.0.4', lic('Apache-2.0')) },
	{ dir: 'node_modules/fx-mpl', manifest: manifest('fx-mpl', '1.0.5', lic('MPL-2.0')) },
	{ dir: 'node_modules/fx-cc0', manifest: manifest('fx-cc0', '1.0.6', lic('CC0-1.0')) },
	{ dir: 'node_modules/fx-0bsd', manifest: manifest('fx-0bsd', '1.0.7', lic('0BSD')) },
	{ dir: 'node_modules/fx-blueoak', manifest: manifest('fx-blueoak', '1.0.8', lic('BlueOak-1.0.0')) },
	{ dir: 'node_modules/fx-agpl', manifest: manifest('fx-agpl', '3.7.1', lic('AGPL-3.0-or-later')) },
	{ dir: 'node_modules/fx-gpl-only', manifest: manifest('fx-gpl-only', '2.0.0', lic('GPL-3.0-only')) },
	// The @img/sharp-libvips case: LGPL-3.0-or-later passes through the LGPL-3.0 family, with no exception.
	{ dir: 'node_modules/@fx/libvips-like', manifest: manifest('@fx/libvips-like', '1.2.4', lic('LGPL-3.0-or-later')) },
	// The json-schema case: an OR passes when any branch is allowed.
	{ dir: 'node_modules/fx-or', manifest: manifest('fx-or', '0.4.0', lic('AFL-2.1 OR BSD-3-Clause')) },
	{ dir: 'node_modules/fx-or-parens', manifest: manifest('fx-or-parens', '0.21.3', lic('(MIT OR CC0-1.0)')) },
	{ dir: 'node_modules/fx-and', manifest: manifest('fx-and', '2.6.0', lic('(BSD-3-Clause AND Apache-2.0)')) },
	// SPDX precedence: AND binds tighter than OR, so this is (SSPL-1.0 AND MIT) OR ISC: allowed via ISC.
	{ dir: 'node_modules/fx-precedence', manifest: manifest('fx-precedence', '1.1.0', lic('SSPL-1.0 AND MIT OR ISC')) },
	// Nested copy (node_modules inside a package) and a scoped package inside a workspace's own node_modules.
	{ dir: 'node_modules/fx-mit/node_modules/fx-nested', manifest: manifest('fx-nested', '0.0.9', lic('MIT')) },
	{ dir: 'packages/ws-a/node_modules/@fx/ws-dep', manifest: manifest('@fx/ws-dep', '4.5.6', lic('Apache-2.0')) },
	// A nested manifest inside a package is not a package: it must not be reported as one without a licence.
	{ dir: 'node_modules/fx-esm', manifest: manifest('fx-esm', '1.0.0', lic('MIT')), files: { 'dist/package.json': '{ "type": "module" }\n' } },
];

const rootFiles = {
	'package.json': `${JSON.stringify({ name: 'fixture-root', private: true, license: 'AGPL-3.0-or-later', workspaces: ['packages/*'] }, null, 2)}\n`,
	'packages/ws-a/package.json': `${JSON.stringify({ name: 'ws-a', version: '0.0.0', private: true, license: 'AGPL-3.0-or-later' }, null, 2)}\n`,
};

const exceptionsFile = (dir: string, exceptions: Exception[]): string => {
	const path = join(dir, 'license-exceptions.json');
	writeFileSync(path, `${JSON.stringify({ exceptions }, null, 2)}\n`);
	return path;
};

// A fresh fixture tree with the allowed packages plus `extra`.
const fixtureTree = (prefix: string, extra: PackageSpec[] = []): string => {
	const root = makeTempDir(`m1s9-${prefix}`);
	temps.push(root);
	writeFiles(root, rootFiles);
	writePackages(root, [...allowedSpecs, ...extra]);
	return root;
};

const validException = (name: string, version: string, license: string): Exception => ({
	name,
	version,
	license,
	evidence: `M1-S9 fixture: LICENSE file in the ${name}@${version} tarball`,
	reason: 'M1-S9 fixture: reviewed exception for a synthetic package',
});

const omit = (e: Exception, field: keyof Exception): Exception => {
	const copy: Exception = { ...e };
	delete copy[field];
	return copy;
};

const readReport = (path: string, r: RunResult): ReportPackage[] => {
	assert.ok(existsSync(path), `--report must write ${path}. ${describeRun(r)}`);
	const report = readJson<{ packages?: ReportPackage[] }>(path);
	assert.ok(Array.isArray(report.packages), `the report must have a "packages" array. ${describeRun(r)}`);
	return report.packages;
};

describe('M1-AC24 check:licenses on fixture trees', () => {
	it('M1-S9-T100 positive control: every allow-listed licence and expression passes, and every package is listed with its licence', () => {
		const root = fixtureTree('allowed');
		const reportPath = join(root, 'report.json');
		const r = checkLicenses('T100-allowed', ['--root', root, '--exceptions', exceptionsFile(root, []), '--report', reportPath]);
		assertExitZero(r);
		const walked = installedPackages(root).filter(p => p.name !== '');
		assert.equal(walked.length, allowedSpecs.length, 'fixture sanity: the independent walker finds exactly the fixture packages');
		for (const p of walked) assertLine(r, 'the listing names every package with its declared licence', keyOf(p.name, p.version), String(p.manifest.license));
		const report = readReport(reportPath, r);
		assert.deepEqual(report.map(p => keyOf(p.name, p.version)).sort(), walked.map(p => keyOf(p.name, p.version)).sort(),
			'the report lists exactly the installed packages (root, nested and workspace node_modules; no nested non-package manifests)');
		for (const p of report) assert.equal(p.status, 'allowed', `${keyOf(p.name, p.version)} must pass by the allow-list, not by an exception`);
	});

	it('M1-S9-T101 (AC NEG) a SSPL-1.0 package and a package with no licence field fail, and both are named', () => {
		const root = fixtureTree('sspl-missing', [
			{ dir: 'node_modules/fx-sspl', manifest: manifest('fx-sspl', '6.0.1', lic('SSPL-1.0')) },
			{ dir: 'packages/ws-a/node_modules/fx-nolicense', manifest: manifest('fx-nolicense', '0.0.1') },
		]);
		const r = checkLicenses('T101-sspl-missing', ['--root', root, '--exceptions', exceptionsFile(root, [])]);
		assertExitNonZero(r);
		assertLine(r, 'the SSPL package is named with its version and licence', 'fx-sspl', '6.0.1', 'SSPL-1.0');
		assertLine(r, 'the package without a licence is named with its version', 'fx-nolicense', '0.0.1', noLicenceMarker);
		assert.ok(!lineWith(r, 'fx-mit@1.0.0', /denied|not allowed|offending|fail/i), `an allowed package must not be reported as offending. ${describeRun(r)}`);
	});

	// Each case alone makes the check fail and is named (one run per case).
	const deniedCases: { id: string; spec: PackageSpec; needles: (string | RegExp)[]; why: string }[] = [
		{ id: 'T102', spec: { dir: 'node_modules/fx-and-denied', manifest: manifest('fx-and-denied', '1.0.0', lic('MIT AND SSPL-1.0')) }, needles: ['fx-and-denied', '1.0.0', 'SSPL-1.0'], why: 'an AND passes only if every branch is allowed' },
		{ id: 'T103', spec: { dir: 'node_modules/fx-or-denied', manifest: manifest('fx-or-denied', '1.0.0', lic('(SSPL-1.0 OR CC-BY-NC-4.0)')) }, needles: ['fx-or-denied', '1.0.0', 'SSPL-1.0'], why: 'an OR with no allowed branch fails' },
		{ id: 'T104', spec: { dir: 'node_modules/fx-gpl2', manifest: manifest('fx-gpl2', '1.0.0', lic('GPL-2.0-only')) }, needles: ['fx-gpl2', '1.0.0', 'GPL-2.0-only'], why: 'GPL-2.0-only is not a variant of an allow-listed licence' },
		{ id: 'T105', spec: { dir: 'node_modules/fx-no-copyleft-exc', manifest: manifest('fx-no-copyleft-exc', '3.7.1', lic('MPL-2.0-no-copyleft-exception')) }, needles: ['fx-no-copyleft-exc', '3.7.1', 'MPL-2.0-no-copyleft-exception'], why: 'MPL-2.0-no-copyleft-exception is a different SPDX ID from MPL-2.0 and needs an exception' },
		{ id: 'T106', spec: { dir: 'node_modules/fx-legacy-array', manifest: manifest('fx-legacy-array', '0.1.2', { licenses: [{ type: 'SSPL-1.0', url: 'https://example.invalid/LICENSE' }] }) }, needles: ['fx-legacy-array', '0.1.2'], why: 'a legacy `licenses` array is never silently passed' },
		{ id: 'T107', spec: { dir: 'node_modules/fx-legacy-object', manifest: manifest('fx-legacy-object', '0.1.3', { license: { type: 'SSPL-1.0', url: 'https://example.invalid/LICENSE' } }) }, needles: ['fx-legacy-object', '0.1.3'], why: 'a legacy `license` object is never silently passed' },
		{ id: 'T108', spec: { dir: 'node_modules/fx-see-file', manifest: manifest('fx-see-file', '2.0.0', lic('SEE LICENSE IN LICENSE.txt')) }, needles: ['fx-see-file', '2.0.0', 'SEE LICENSE IN'], why: 'a non-SPDX pointer is not an allowed licence' },
		{ id: 'T109', spec: { dir: 'node_modules/fx-unlicensed', manifest: manifest('fx-unlicensed', '1.0.0', lic('UNLICENSED')) }, needles: ['fx-unlicensed', '1.0.0', 'UNLICENSED'], why: 'UNLICENSED (proprietary) fails' },
	];
	for (const c of deniedCases) {
		it(`M1-S9-${c.id} NEG: ${c.why}`, () => {
			const root = fixtureTree(c.id, [c.spec]);
			const r = checkLicenses(`${c.id}-denied`, ['--root', root, '--exceptions', exceptionsFile(root, [])]);
			assertExitNonZero(r);
			assertLine(r, `${c.why}; the offending package is named`, ...c.needles);
		});
	}
});

describe('M1-AC24 reviewed exceptions', () => {
	const excSpecs: PackageSpec[] = [
		{ dir: 'packages/ws-a/node_modules/@fx/converter', manifest: manifest('@fx/converter', '3.7.1', lic('MPL-2.0-no-copyleft-exception')) },
		{ dir: 'packages/ws-a/node_modules/fx-bitmap', manifest: manifest('fx-bitmap', '0.0.1') },
	];
	const goodExceptions = (): Exception[] => [
		validException('@fx/converter', '3.7.1', 'MPL-2.0-no-copyleft-exception'),
		{ ...validException('fx-bitmap', '0.0.1', 'UNKNOWN'), prepublishBlocker: true },
	];

	it('M1-S9-T110 positive control: exact-version exceptions with licence, evidence and reason make the tree pass, reported as exceptions', () => {
		const root = fixtureTree('exc-ok', excSpecs);
		const reportPath = join(root, 'report.json');
		const r = checkLicenses('T110-exceptions-ok', ['--root', root, '--exceptions', exceptionsFile(root, goodExceptions()), '--report', reportPath]);
		assertExitZero(r);
		const report = readReport(reportPath, r);
		const status = new Map(report.map(p => [keyOf(p.name, p.version), p.status]));
		assert.equal(status.get('@fx/converter@3.7.1'), 'exception', 'the MPL-2.0-no-copyleft-exception package passes by its exception');
		assert.equal(status.get('fx-bitmap@0.0.1'), 'exception', 'the package without a licence passes by its exception, never silently');
		assert.equal(status.get('fx-mit@1.0.0'), 'allowed', 'allow-listed packages are not reported as exceptions');
	});

	it('M1-S9-T111 control: the same tree without the exceptions fails, naming both packages', () => {
		const root = fixtureTree('exc-none', excSpecs);
		const r = checkLicenses('T111-exceptions-none', ['--root', root, '--exceptions', exceptionsFile(root, [])]);
		assertExitNonZero(r);
		assertLine(r, 'the converter is named', '@fx/converter', '3.7.1', 'MPL-2.0-no-copyleft-exception');
		assertLine(r, 'the package without a licence is named', 'fx-bitmap', '0.0.1', noLicenceMarker);
	});

	// Each defect in one exception entry alone makes the check fail and names the entry's package.
	const badCases: { id: string; why: string; edit: (e: Exception) => Exception; needles: (string | RegExp)[] }[] = [
		{ id: 'T112', why: '(AC NEG) an exception without a reason fails', edit: e => omit(e, 'reason'), needles: ['fx-bitmap', /reason/i] },
		{ id: 'T113', why: 'an exception with an empty reason fails', edit: e => ({ ...e, reason: '  ' }), needles: ['fx-bitmap', /reason/i] },
		{ id: 'T114', why: '(AC NEG) an exception whose version does not match the installed one fails', edit: e => ({ ...e, version: '0.0.2' }), needles: ['fx-bitmap', '0.0.1'] },
		{ id: 'T115', why: 'an exception with a version range fails (exact versions only, so a bump forces a re-review)', edit: e => ({ ...e, version: '^0.0.1' }), needles: ['fx-bitmap', /version/i] },
		{ id: 'T116', why: 'an exception without evidence fails', edit: e => omit(e, 'evidence'), needles: ['fx-bitmap', /evidence/i] },
		{ id: 'T117', why: 'an exception without the established licence fails', edit: e => omit(e, 'license'), needles: ['fx-bitmap', /licen[cs]e/i] },
	];
	for (const c of badCases) {
		it(`M1-S9-${c.id} NEG: ${c.why}`, () => {
			const root = fixtureTree(c.id, excSpecs);
			const [converter, bitmap] = goodExceptions();
			const r = checkLicenses(`${c.id}-bad-exception`, ['--root', root, '--exceptions', exceptionsFile(root, [converter, c.edit(bitmap)])]);
			assertExitNonZero(r);
			assertLine(r, c.why, ...c.needles);
		});
	}
});

describe('M1-AC24 the real installed tree (integration)', () => {
	it('M1-S9-T120 `corepack yarn check:licenses` passes on this repo, lists every installed package and applies the architect\'s dispositions', () => {
		const reportPath = join(makeTempDir('m1s9-real'), 'report.json');
		temps.push(join(reportPath, '..'));
		const r = checkLicenses('T120-repo', ['--report', reportPath]);
		assertExitZero(r);

		// Every installed package (root, workspaces, nested) is listed and reported: an independent walk.
		const walked = installedPackages(repoRoot).filter(p => p.name !== '');
		assert.ok(walked.length > 500, `fixture sanity: expected the real tree (joplin@3.7.1 and the tooling), found ${walked.length} packages`);
		const report = readReport(reportPath, r);
		const reported = new Map(report.map(p => [keyOf(p.name, p.version), p]));
		const unlisted = [...new Set(walked.map(p => keyOf(p.name, p.version)))].filter(k => !reported.has(k) || !r.output.includes(k));
		assert.deepEqual(unlisted, [], 'every installed package must be in the listing and in the report');

		// No package without a declared licence passes silently.
		for (const p of walked) {
			if (p.manifest.license === undefined && p.manifest.licenses === undefined) {
				assert.equal(reported.get(keyOf(p.name, p.version))?.status, 'exception', `${keyOf(p.name, p.version)} has no licence field; only a reviewed exception may pass it`);
			}
		}

		// The architect's dispositions (docs/backlog/M1.md §M1-AC24, review M1-S1-r1).
		const libvips = report.filter(p => p.name.startsWith('@img/sharp-libvips-'));
		assert.ok(libvips.length > 0, 'fixture sanity: an @img/sharp-libvips-* package is installed (joplin@3.7.1 → sharp)');
		for (const p of libvips) {
			assert.equal(p.license, 'LGPL-3.0-or-later', `${keyOf(p.name, p.version)} declared licence`);
			assert.equal(p.status, 'allowed', `${keyOf(p.name, p.version)} passes by the LGPL-3.0 family (-or-later), with no exception`);
		}
		assert.equal(reported.get('json-schema@0.4.0')?.status, 'allowed', 'json-schema@0.4.0 (AFL-2.1 OR BSD-3-Clause) passes through the OR rule');
		for (const k of ['@joplin/onenote-converter@3.7.1', 'node-bitmap@0.0.1', 'tkwidgets@0.5.27']) {
			assert.equal(reported.get(k)?.status, 'exception', `${k} passes only by a reviewed exception`);
		}

		// The default exception list: exact versions, licence, evidence and reason on every entry.
		assert.ok(existsSync(defaultExceptions), `the reviewed exception list must live at ${defaultExceptions}`);
		const list = JSON.parse(readFileSync(defaultExceptions, 'utf8')) as { exceptions?: Exception[] };
		assert.ok(Array.isArray(list.exceptions), 'license-exceptions.json must have an "exceptions" array');
		const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
		for (const e of list.exceptions) {
			const id = `${String(e.name)}@${String(e.version)}`;
			assert.ok(nonEmpty(e.name) && typeof e.version === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(e.version), `${id}: name and an exact version`);
			for (const field of ['license', 'evidence', 'reason'] as const) assert.ok(nonEmpty(e[field]), `${id}: non-empty "${field}"`);
			if (e.license === 'UNKNOWN') assert.equal(e.prepublishBlocker, true, `${id}: no licence established, so it must be marked "prepublishBlocker": true for the M5 gate`);
		}
		const listed = new Set(list.exceptions.map(e => `${String(e.name)}@${String(e.version)}`));
		for (const k of ['@joplin/onenote-converter@3.7.1', 'node-bitmap@0.0.1', 'tkwidgets@0.5.27']) assert.ok(listed.has(k), `license-exceptions.json must have an entry for ${k}`);
		for (const e of list.exceptions) {
			assert.ok(!String(e.name).startsWith('@img/sharp-libvips-') && e.name !== 'json-schema', `${String(e.name)} needs no exception (allow-list), so it must not have one`);
		}
	});
});
