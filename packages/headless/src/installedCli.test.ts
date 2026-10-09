import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findInstalledCli, findPinnedCli, pinnedCliVersion } from './installedCli.ts';

const packageDir = join(__dirname, '..');
const pinPath = join(__dirname, '..', '..', '..', 'upstream', 'joplin-version.json');
const readPin = (): { cli: { npm: string; version: string } } => JSON.parse(readFileSync(pinPath, 'utf8'));

describe('installedCli', () => {
	test('finds the installed CLI at exactly the pinned version, with an existing bin', () => {
		const { cli } = readPin();
		const installed = findInstalledCli(packageDir, cli.npm);
		expect(installed.name).toBe(cli.npm);
		expect(installed.version).toBe(cli.version);
		expect(installed.binPath).toMatch(/[\\/]joplin[\\/]main\.js$/);
		expect(existsSync(installed.binPath)).toBe(true);
	});

	test('the headless manifest pins the CLI to the exact pinned version', () => {
		const { cli } = readPin();
		const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
		expect(manifest.dependencies[cli.npm]).toBe(cli.version);
	});

	test('findPinnedCli accepts the installed CLI at the manifest pin', () => {
		const { cli } = readPin();
		expect(pinnedCliVersion(packageDir, cli.npm)).toBe(cli.version);
		expect(findPinnedCli(packageDir, cli.npm).version).toBe(cli.version);
	});

	test('findPinnedCli refuses a range or a different installed version', () => {
		const dir = mkdtempSync(join(tmpdir(), 'headless-pin-'));
		try {
			const fake = join(dir, 'node_modules', 'fakecli');
			mkdirSync(fake, { recursive: true });
			writeFileSync(join(fake, 'package.json'), '{"name":"fakecli","version":"1.0.1","bin":{"fakecli":"main.js"}}');
			writeFileSync(join(dir, 'package.json'), '{"name":"probe","dependencies":{"fakecli":"^1.0.0"}}');
			expect(() => findPinnedCli(dir, 'fakecli')).toThrow('must pin "fakecli" to an exact version');
			writeFileSync(join(dir, 'package.json'), '{"name":"probe","dependencies":{"fakecli":"1.0.0"}}');
			expect(() => findPinnedCli(dir, 'fakecli')).toThrow('the installed fakecli is 1.0.1, but');
			writeFileSync(join(dir, 'package.json'), '{"name":"probe","dependencies":{"fakecli":"1.0.1"}}');
			expect(findPinnedCli(dir, 'fakecli').version).toBe('1.0.1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fails with the package name when the CLI is not installed', () => {
		const dir = mkdtempSync(join(tmpdir(), 'headless-cli-'));
		try {
			writeFileSync(join(dir, 'package.json'), '{"name":"probe"}');
			expect(() => findInstalledCli(dir, 'notestead-no-such-cli')).toThrow('The CLI package "notestead-no-such-cli" is not installed');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
