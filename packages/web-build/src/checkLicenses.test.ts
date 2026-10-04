import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheckLicenses } from './checkLicenses.ts';
import { installedPackages, workspaceDirs } from './installedPackages.ts';
import { loadExceptions, parseExceptions } from './licenseExceptions.ts';
import { removeTempDirs, repoRoot, tempDir, writeFiles } from './testing/fixtures.ts';

const pkg = (name: string, version: string, fields: Record<string, unknown> = {}): string => JSON.stringify({ name, version, ...fields });

// A root with a workspace, nested and scoped packages, a decoy manifest inside a package and a workspace symlink.
const tree = (extra: Record<string, string> = {}): string => {
	const root = tempDir('tree');
	writeFiles(root, {
		'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
		'packages/ws/package.json': pkg('ws', '0.0.0'),
		'node_modules/a/package.json': pkg('a', '1.0.0', { license: 'MIT' }),
		'node_modules/a/dist/package.json': '{ "type": "module" }',
		'node_modules/a/node_modules/b/package.json': pkg('b', '2.0.0', { license: 'ISC' }),
		'node_modules/@s/c/package.json': pkg('@s/c', '3.0.0', { licenses: [{ type: 'Apache-2.0' }] }),
		'node_modules/.bin/a': '#!/bin/sh\n',
		'packages/ws/node_modules/d/package.json': pkg('d', '4.0.0', { license: 'BSD-3-Clause' }),
		...extra,
	});
	symlinkSync('../packages/ws', join(root, 'node_modules', 'ws'));
	return root;
};

const exceptions = (list: unknown[]): string => {
	const path = join(tempDir('exc'), 'license-exceptions.json');
	writeFileSync(path, JSON.stringify({ exceptions: list }));
	return path;
};

const entry = (name: string, version: string, fields: Record<string, unknown> = {}) => ({ name, version, license: 'MIT', evidence: 'LICENSE in the tarball', reason: 'reviewed', ...fields });

const run = (argv: string[]) => {
	const info: string[] = [];
	const error: string[] = [];
	const code = runCheckLicenses(argv, repoRoot, { info: l => info.push(l), error: l => error.push(l) });
	return { code, info, error };
};

describe('checkLicenses', () => {
	afterAll(removeTempDirs);

	test('walks root, nested, scoped and workspace node_modules, and nothing else', () => {
		const root = tree();
		expect(workspaceDirs(root)).toEqual([join(root, 'packages', 'ws')]);
		expect(installedPackages(root).map(p => `${p.name}@${p.version} ${p.rel}`)).toEqual([
			'@s/c@3.0.0 node_modules/@s/c',
			'a@1.0.0 node_modules/a',
			'b@2.0.0 node_modules/a/node_modules/b',
			'd@4.0.0 packages/ws/node_modules/d',
		]);
		writeFiles(root, { 'package.json': JSON.stringify({ workspaces: ['packages/**'] }) });
		expect(() => workspaceDirs(root)).toThrow('unsupported workspaces pattern');
	});

	test('lists every package, writes the report and passes an allowed tree', () => {
		const root = tree();
		const report = join(tempDir('report'), 'r.json');
		const result = run(['--root', root, '--exceptions', exceptions([]), '--report', report]);
		expect(result.error).toEqual([]);
		expect(result.code).toBe(0);
		expect(result.info).toContain('@s/c@3.0.0  Apache-2.0 [legacy licenses array]  allowed  (node_modules/@s/c)');
		expect(JSON.parse(readFileSync(report, 'utf8')).packages).toContainEqual({ name: 'b', version: '2.0.0', path: 'node_modules/a/node_modules/b', license: 'ISC', status: 'allowed' });
	});

	test('denies a missing, unparsable or unlisted licence and names each one, unless an exact exception covers it', () => {
		const root = tree({
			'node_modules/none/package.json': pkg('none', '0.0.1'),
			'node_modules/sspl/package.json': pkg('sspl', '1.0.0', { license: 'SSPL-1.0' }),
			'node_modules/pointer/package.json': pkg('pointer', '1.0.0', { license: 'SEE LICENSE IN LICENSE' }),
			'node_modules/broken/package.json': '{ nope',
		});
		const denied = run(['--root', root, '--exceptions', exceptions([])]);
		expect(denied.code).toBe(1);
		expect(denied.error).toEqual(expect.arrayContaining([
			expect.stringMatching(/^ {2}- DENIED none@0\.0\.1 \(node_modules\/none\): no licence declared/),
			expect.stringMatching(/^ {2}- DENIED sspl@1\.0\.0 .*SSPL-1\.0 is not on the ADR-0009 allow-list/),
			expect.stringMatching(/^ {2}- DENIED pointer@1\.0\.0 .*SEE LICENSE IN LICENSE is not an SPDX licence expression/),
			expect.stringMatching(/^ {2}- DENIED broken@ \(node_modules\/broken\): its package\.json cannot be read/),
		]));
		const report = join(tempDir('report'), 'r.json');
		const covered = run(['--root', root, '--report', report, '--exceptions', exceptions([
			entry('none', '0.0.1', { license: 'UNKNOWN', prepublishBlocker: true }), entry('sspl', '1.0.0'), entry('pointer', '1.0.0'), entry('broken', ''),
		])]);
		expect(covered.code).toBe(1);
		expect(covered.error.filter(l => l.includes('DENIED'))).toEqual([expect.stringContaining('DENIED broken@')]);
		const statuses = JSON.parse(readFileSync(report, 'utf8')).packages.map((p: { name: string; status: string }) => `${p.name}:${p.status}`);
		expect(statuses).toEqual(expect.arrayContaining(['none:exception', 'sspl:exception', 'pointer:exception', 'a:allowed']));
	});

	test('fails on an exception for another version of an installed package, and notes unused and unneeded ones', () => {
		const root = tree();
		const result = run(['--root', root, '--exceptions', exceptions([entry('a', '1.0.1'), entry('a', '1.0.0'), entry('elsewhere', '9.9.9')])]);
		expect(result.code).toBe(1);
		expect(result.error).toContainEqual(expect.stringMatching(/the exception a@1\.0\.1 matches no installed copy; installed: a@1\.0\.0$/));
		expect(result.info).toContain('check:licenses: note: a@1.0.0 is allowed by the allow-list; its exception is not needed here');
		expect(result.info).toContainEqual(expect.stringMatching(/1 exception\(s\) match no package installed .*: elsewhere@9\.9\.9$/));
	});

	test('validates every exception entry, naming its package', () => {
		const { entries, problems } = parseExceptions({ '//': 'comment', 'exceptions': [
			entry('ok', '1.0.0', { noticeText: 'text', prepublishBlocker: false }),
			entry('range', '^1.0.0'),
			entry('blank', '1.0.0', { reason: '  ' }),
			{ name: 'bare', version: '1.0.0' },
			entry('unknown', '1.0.0', { license: 'UNKNOWN' }),
			entry('typo', '1.0.0', { reasons: 'x', noticeText: '' }),
			entry('ok', '1.0.0'),
			'not an object',
		] }, 'exc.json');
		expect([...entries.keys()]).toEqual(['ok@1.0.0']);
		expect(problems).toEqual([
			'exc.json exceptions[1] range@^1.0.0: "version" must be an exact version (no range, so a bump forces a re-review), got "^1.0.0"',
			'exc.json exceptions[2] blank@1.0.0: "reason" must be a non-empty string',
			'exc.json exceptions[3] bare@1.0.0: "license" must be a non-empty string',
			'exc.json exceptions[3] bare@1.0.0: "evidence" must be a non-empty string',
			'exc.json exceptions[3] bare@1.0.0: "reason" must be a non-empty string',
			'exc.json exceptions[4] unknown@1.0.0: "license" is "UNKNOWN", so "prepublishBlocker" must be true (M5 pre-publish gate)',
			'exc.json exceptions[5] typo@1.0.0: "noticeText", when given, must be a non-empty string',
			'exc.json exceptions[5] typo@1.0.0: unknown key "reasons"',
			'exc.json exceptions[6] ok@1.0.0: ok@1.0.0 has more than one entry',
			'exc.json exceptions[7]: must be an object',
		]);
		expect(parseExceptions({ exceptions: [], extra: 1 }, 'x').problems).toEqual(['x: unknown top-level key "extra"']);
		expect(parseExceptions([], 'x').problems).toEqual(['x: must be an object with an "exceptions" array']);
	});

	test('the repository exception list is valid and the repository tree passes', () => {
		expect(loadExceptions(join(repoRoot, 'packages', 'web-build', 'license-exceptions.json')).problems).toEqual([]);
		const missing = join(tempDir('none'), 'x.json');
		mkdirSync(join(missing, '..'), { recursive: true });
		expect(run(['--exceptions', missing]).code).toBe(1);
		expect(run(['--bogus']).code).toBe(2);
		expect(run([]).code).toBe(0);
	});
});
