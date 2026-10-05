import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, parseServerUrl, readSecretFile, stripOneTrailingNewline } from './config.ts';

const syncPassword = 'pw with space Δ$x!';
const masterPassword = 'master Δ$x!';

describe('config', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'headless-config-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const writeSecrets = (password = `${syncPassword}\n`, master = masterPassword): void => {
		writeFileSync(join(dir, 'joplin_password'), password);
		writeFileSync(join(dir, 'e2ee_master_password'), master);
	};

	test('strips exactly one trailing line break from a secret', () => {
		expect(stripOneTrailingNewline('a\n')).toBe('a');
		expect(stripOneTrailingNewline('a\r\n')).toBe('a');
		expect(stripOneTrailingNewline('a\n\n')).toBe('a\n');
		expect(stripOneTrailingNewline(' a ')).toBe(' a ');
		expect(stripOneTrailingNewline('a')).toBe('a');
	});

	test('reads the env and both secret files; every other byte of a secret is kept', () => {
		writeSecrets();
		expect(loadConfig({ JOPLIN_SERVER_URL: 'http://web:8089/joplin-server/', JOPLIN_USERNAME: ' user@example.com ' }, dir)).toEqual({
			serverUrl: 'http://web:8089/joplin-server',
			username: 'user@example.com',
			syncPassword,
			masterPassword,
		});
	});

	test('names the missing or empty secret file, never a value', () => {
		writeSecrets('\n');
		expect(() => readSecretFile(join(dir, 'joplin_password'))).toThrow(`the secret file ${join(dir, 'joplin_password')} is empty`);
		expect(() => readSecretFile(join(dir, 'missing'))).toThrow(`cannot read the secret file ${join(dir, 'missing')} (ENOENT)`);
	});

	test.each([
		[undefined, 'JOPLIN_SERVER_URL is required'],
		['web:8089', 'must use http or https'],
		['not a url', 'not a valid URL'],
		['ftp://web/joplin', 'must use http or https'],
		['http://user:secretvalue@web:8089', 'must not contain credentials'],
		['http://web:8089/joplin-server?token=abc', 'must not contain a query or a fragment'],
		['http://web:8089/joplin-server#x', 'must not contain a query or a fragment'],
	])('rejects JOPLIN_SERVER_URL=%s', (value, message) => {
		let error: unknown;
		try {
			parseServerUrl(value);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as Error).message).toContain(message);
		expect((error as Error).message).not.toContain('secretvalue');
	});

	test('requires JOPLIN_USERNAME', () => {
		writeSecrets();
		expect(() => loadConfig({ JOPLIN_SERVER_URL: 'http://web:8089/joplin-server', JOPLIN_USERNAME: ' ' }, dir)).toThrow('JOPLIN_USERNAME is required');
	});
});
