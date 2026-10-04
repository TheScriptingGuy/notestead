import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLockfile, packageNameOf, parseLockfile } from './lockfile.ts';
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
});
