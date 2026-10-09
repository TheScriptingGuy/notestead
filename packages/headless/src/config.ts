// Supervisor configuration (ADR-0003 Decision 6, ADR-0008): non-secret values from the environment, secrets from
// files under /run/secrets (podman/docker secrets). Secret values stay in memory: they are never put in argv, in the
// environment of a child process or in a log line. Error messages name the variable or file, never a value.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SupervisorConfig {
	// The Joplin Server URL the CLI syncs with (`sync.9.path`), without a trailing slash.
	serverUrl: string;
	// The Joplin Server account (`sync.9.username`).
	username: string;
	syncPassword: string;
	masterPassword: string;
}

export const secretNames = {
	syncPassword: 'joplin_password',
	masterPassword: 'e2ee_master_password',
} as const;

export const defaultSecretsDir = '/run/secrets';

export class ConfigError extends Error {}

// A secret file holds the secret plus at most one trailing line break (`echo pw > file` writes one). Exactly one
// trailing "\n" or "\r\n" is removed; every other byte belongs to the secret.
export const stripOneTrailingNewline = (text: string): string => {
	if (text.endsWith('\r\n')) return text.slice(0, -2);
	if (text.endsWith('\n')) return text.slice(0, -1);
	return text;
};

export const readSecretFile = (path: string, readFile: (path: string) => string = p => readFileSync(p, 'utf8')): string => {
	let raw: string;
	try {
		raw = readFile(path);
	} catch (error) {
		throw new ConfigError(`cannot read the secret file ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
	}
	const value = stripOneTrailingNewline(raw);
	if (value === '') throw new ConfigError(`the secret file ${path} is empty`);
	return value;
};

// JOPLIN_SERVER_URL must be a plain http(s) base URL: credentials belong in the secrets, and a query or fragment
// has no meaning for the sync target (and would end up in logs).
export const parseServerUrl = (value: string | undefined): string => {
	if (!value || value.trim() === '') throw new ConfigError('JOPLIN_SERVER_URL is required');
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError('JOPLIN_SERVER_URL is not a valid URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError('JOPLIN_SERVER_URL must use http or https');
	if (url.username || url.password) throw new ConfigError('JOPLIN_SERVER_URL must not contain credentials (use the joplin_password secret)');
	if (url.search || url.hash || value.includes('?') || value.includes('#')) throw new ConfigError('JOPLIN_SERVER_URL must not contain a query or a fragment');
	return url.href.replace(/\/+$/, '');
};

export const loadConfig = (
	env: NodeJS.ProcessEnv,
	secretsDir: string = defaultSecretsDir,
	readFile?: (path: string) => string,
): SupervisorConfig => {
	const serverUrl = parseServerUrl(env.JOPLIN_SERVER_URL);
	const username = (env.JOPLIN_USERNAME ?? '').trim();
	if (username === '') throw new ConfigError('JOPLIN_USERNAME is required');
	return {
		serverUrl,
		username,
		syncPassword: readSecretFile(join(secretsDir, secretNames.syncPassword), readFile),
		masterPassword: readSecretFile(join(secretsDir, secretNames.masterPassword), readFile),
	};
};
