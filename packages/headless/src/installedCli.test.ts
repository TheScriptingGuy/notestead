import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findInstalledCli } from './installedCli.ts';

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
