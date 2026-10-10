// The harness's secret registry (docs/test-plans/M1-S6a.md §C1 design; ADR-0007, ADR-0008). Every secret a test
// fixture or a test creates (account and master passwords, Data API tokens, later the MCP bearer token) is registered
// here, so that whatever writes or keeps an artifact can redact it:
// - in the process that registers it (a Playwright worker, a Jest test, the developer CLI): an in-memory list, used to
//   redact the worker's stdout/stderr at the source (installStdioRedaction);
// - across processes: when NOTESTEAD_SECRETS_FILE is set (the Playwright globalSetup sets it), the secrets are also
//   appended to that 0600 JSON-lines file, which the redacting reporter in the runner process reads.
// Shared by Jest (CommonJS) and Playwright/Node (ESM): no __dirname, no import.meta.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { looksLikeText, redactText } from './redact.ts';
import type { KnownSecret } from './redact.ts';

export const secretsFileEnv = 'NOTESTEAD_SECRETS_FILE';
const minLength = 6; // redactText ignores shorter values

// Self-test runs only (NST_SELFTEST_OUT set): NST_SELFTEST_SECRET_FEED=off makes the harness behave as before M1-S6a C1
// (only the default account is known), for the C1 negative control. Ignored in every other run.
export const secretFeedEnabled = (): boolean => !(process.env.NST_SELFTEST_OUT && process.env.NST_SELFTEST_SECRET_FEED === 'off');

const registered: KnownSecret[] = [];
// file → values already appended to it by this process
const written = new Map<string, Set<string>>();

const usable = (s: KnownSecret): boolean => typeof s.value === 'string' && s.value.length >= minLength;

export const registerSecrets = (secrets: KnownSecret[]): void => {
	if (!secretFeedEnabled()) return;
	for (const s of secrets) if (usable(s) && !registered.some(r => r.value === s.value)) registered.push({ label: s.label, value: s.value });
	const file = process.env[secretsFileEnv];
	if (!file) return;
	const done = written.get(file) ?? new Set<string>();
	written.set(file, done);
	const fresh = secrets.filter(s => usable(s) && !done.has(s.value));
	if (fresh.length === 0) return;
	appendFileSync(file, fresh.map(s => `${JSON.stringify({ label: s.label, value: s.value })}\n`).join(''), { mode: 0o600 });
	for (const s of fresh) done.add(s.value);
};

// The secrets this process registered.
export const registeredSecrets = (): KnownSecret[] => [...registered];

// Every secret in a registry file (a malformed or partly written line is skipped).
export const readSecretsFile = (file: string | undefined): KnownSecret[] => {
	if (!file || !existsSync(file)) return [];
	const out: KnownSecret[] = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (line.trim() === '') continue;
		try {
			const s = JSON.parse(line) as KnownSecret;
			if (usable(s) && typeof s.label === 'string' && !out.some(o => o.value === s.value)) out.push({ label: s.label, value: s.value });
		} catch {
			// a line being written by another process
		}
	}
	return out;
};

// A fresh registry file (0600, in a fresh 0700 dir outside the repository), exported to this process's environment
// so that the workers Playwright starts afterwards inherit it.
export const createSecretsFile = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'nst-secrets-'));
	const file = join(dir, 'secrets.jsonl');
	writeFileSync(file, '', { mode: 0o600 });
	process.env[secretsFileEnv] = file;
	return file;
};

export const removeSecretsFile = (file: string | undefined): void => {
	if (!file || basename(file) !== 'secrets.jsonl' || !basename(dirname(file)).startsWith('nst-secrets-')) return;
	rmSync(dirname(file), { recursive: true, force: true });
};

// Labels and order: longer values first, so a secret that contains another is replaced whole.
export const mergeSecrets = (...lists: KnownSecret[][]): KnownSecret[] => {
	const out: KnownSecret[] = [];
	for (const s of lists.flat()) if (usable(s) && !out.some(o => o.value === s.value)) out.push(s);
	return out.sort((a, b) => b.value.length - a.value.length);
};

type Write = typeof process.stdout.write;

// Redacts every chunk written to process.stdout and process.stderr with `secrets()` (called per write) before it goes
// on to the previous write function (in a Playwright worker: the one that forwards the chunk to the runner, whose
// `list` reporter prints it live). Returns a function that restores the previous write functions.
export const installStdioRedaction = (secrets: () => KnownSecret[]): (() => void) => {
	const restores = [process.stdout, process.stderr].map(stream => {
		const previous = stream.write;
		const wrapped = function(this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
			let out = chunk;
			if (typeof chunk === 'string') {
				out = redactText(chunk, secrets());
			} else if (chunk instanceof Uint8Array) {
				const data = Buffer.from(chunk);
				if (looksLikeText(data)) out = Buffer.from(redactText(data.toString('utf8'), secrets()), 'utf8');
			}
			return (previous as (...args: unknown[]) => boolean).call(this, out, ...rest);
		};
		stream.write = wrapped as Write;
		return () => {
			if (stream.write === wrapped) stream.write = previous;
		};
	});
	return () => restores.forEach(r => r());
};
