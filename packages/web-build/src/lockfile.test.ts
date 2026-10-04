import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLockfile, packageNameOf, parseLockfile, resolutionProtocol } from './lockfile.ts';
import type { Pin } from './pin.ts';

const fixtures = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'm1-s1');
const pin = (): Pin => JSON.parse(readFileSync(join(fixtures, 'pin', 'valid.json'), 'utf8'));
const lockfile = (name: string) => parseLockfile(readFileSync(join(fixtures, 'lockfile', name), 'utf8'));

describe('lockfile', () => {
	test('derives package names from scoped and unscoped locators', () => {
		expect(packageNameOf('@joplin/lib@npm:3.7.1')).toBe('@joplin/lib');
		expect(packageNameOf('joplin@npm:3.7.1')).toBe('joplin');
		expect(packageNameOf('joplin-turndown-plugin-gfm@npm:1.0.12')).toBe('joplin-turndown-plugin-gfm');
		expect(packageNameOf('headless@workspace:packages/headless')).toBe('headless');
	});

	test('parses entries with multi-descriptor keys and skips the metadata block', () => {
		const lib = lockfile('valid.yarn.lock').filter(e => e.name === '@joplin/lib');
		expect(lib).toEqual([{
			key: '@joplin/lib@npm:^3.7.1, @joplin/lib@npm:~3.7',
			name: '@joplin/lib',
			version: '3.7.1',
			resolution: '@joplin/lib@npm:3.7.1',
		}]);
		expect(lockfile('valid.yarn.lock').some(e => e.key === '__metadata')).toBe(false);
	});

	test('accepts the valid fixture: forks at their own versions and the joplin-* decoy are not checked', () => {
		expect(checkLockfile(lockfile('valid.yarn.lock'), pin(), 'yarn.lock')).toEqual([]);
	});

	test('accepts the repository lockfile', () => {
		const root = join(__dirname, '..', '..', '..');
		const repoPin: Pin = JSON.parse(readFileSync(join(root, 'upstream', 'joplin-version.json'), 'utf8'));
		const entries = parseLockfile(readFileSync(join(root, 'yarn.lock'), 'utf8'));
		expect(checkLockfile(entries, repoPin, 'yarn.lock')).toEqual([]);
		expect(entries.filter(e => e.name === 'joplin').map(e => e.version)).toEqual([repoPin.cli.version]);
	});

	test.each([
		['joplin-lib-3.8.0.yarn.lock', '@joplin/lib', '3.8.0'],
		['joplin-utils-3.6.4.yarn.lock', '@joplin/utils', '3.6.4'],
		['joplin-cli-3.7.2.yarn.lock', 'joplin', '3.7.2'],
	])('rejects %s naming %s and %s', (file, name, version) => {
		const problems = checkLockfile(lockfile(file), pin(), file);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(new RegExp(`^${name.replace('/', '\\/')}: .* to ${version.replace(/\./g, '\\.')}, expected`));
	});

	test('rejects a lockfile without the CLI, naming the package', () => {
		expect(checkLockfile(lockfile('joplin-cli-absent.yarn.lock'), pin(), 'yarn.lock')).toEqual([
			expect.stringMatching(/^joplin: yarn\.lock has no entry for the pinned CLI package "joplin"/),
		]);
	});

	test('checks an unknown lockstep @joplin/* package (fail closed)', () => {
		const entries = [...lockfile('valid.yarn.lock'), { key: '@joplin/new@npm:^4.0.0', name: '@joplin/new', version: '4.0.0', resolution: '@joplin/new@npm:4.0.0' }];
		expect(checkLockfile(entries, pin(), 'yarn.lock')).toEqual([expect.stringMatching(/^@joplin\/new: .* to 4\.0\.0, expected 3\.7\.x/)]);
	});

	test('names the protocol of a resolution', () => {
		expect(resolutionProtocol('@joplin/lib@npm:3.7.1')).toBe('npm');
		expect(resolutionProtocol('joplin@patch:joplin@npm%3A3.7.1#~/local.patch::version=3.7.1')).toBe('patch');
		expect(resolutionProtocol('@joplin/lib@https://github.com/someone/fork.git#commit=abc')).toBe('https');
		expect(resolutionProtocol('@joplin/htmlpack@git+ssh://git@github.com/someone/htmlpack.git')).toBe('git+ssh');
		expect(resolutionProtocol('@joplin/fork-sax@github:someone/fork-sax')).toBe('github');
		expect(resolutionProtocol('@joplin/utils@file:../utils::locator=x')).toBe('file');
		expect(resolutionProtocol('weird@1.0.0')).toBe('unknown');
	});

	test.each([
		['@joplin/lib', '3.7.1', '@joplin/lib@https://github.com/someone/fork.git#commit=abc', 'https'],
		['joplin', '3.7.1', 'joplin@patch:joplin@npm%3A3.7.1#~/local.patch::version=3.7.1', 'patch'],
		['@joplin/fork-sax', '1.2.68', '@joplin/fork-sax@github:someone/fork-sax#commit=abc', 'github'],
		['@joplin/renderer', '3.7.1', '@joplin/renderer@link:../renderer::locator=x', 'link'],
		['@joplin/utils', '3.7.1', '@joplin/utils@npm:3.7.2', 'npm'],
	])('rejects %s resolved through anything but <name>@npm:<version> (%s, %s)', (name, version, resolution, protocol) => {
		const entries = lockfile('valid.yarn.lock').map(e => e.name === name ? { ...e, version, resolution } : e);
		const problems = checkLockfile(entries, pin(), 'yarn.lock').filter(p => p.includes('npm registry'));
		expect(problems).toEqual([expect.stringMatching(new RegExp(`^${name.replace('/', '\\/')}: yarn\\.lock resolves .*${protocol === 'npm' ? 'does not match its version' : `uses the ${protocol} protocol`}`))]);
	});

	test('leaves the resolutions of other packages alone (yarn builtin patches, joplin-* decoys)', () => {
		const entries = lockfile('valid.yarn.lock').map(e => {
			if (e.name === 'lodash') return { ...e, resolution: 'lodash@patch:lodash@npm%3A4.17.21#optional!builtin<compat/lodash>' };
			if (e.name === 'joplin-turndown-plugin-gfm') return { ...e, resolution: 'joplin-turndown-plugin-gfm@https://example.org/x.git' };
			return e;
		});
		expect(checkLockfile(entries, pin(), 'yarn.lock')).toEqual([]);
	});
});
