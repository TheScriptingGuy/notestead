// M1-S8 C1-R2 on a real Playwright process (review M1-S6a-r1 C1-R2; docs/test-plans/M1-S8.md §C1-R2): a run killed
// with SIGKILL after its worker wrote an unredacted trace (a CI job timeout or cancellation) leaves that trace in the
// output dir; the upload gate, run as CI runs it, must leave nothing that holds the secret. Positive control: the same
// run allowed to finish marks its redaction complete, and the gate keeps its (already redacted) trace.
// NEG control: right after the kill, before the gate, the secret IS in the output (the channel is real).
import { afterAll, describe, expect, test } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { waitFor } from '../../support/poll.ts';
import { textViews } from '../../support/redact.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { completeMarker, pendingMarker } from '../../support/uploadGate.ts';

const repoRoot = findRepoRoot();
const minute = 60_000;

const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap(name => {
	const p = join(dir, name);
	return statSync(p).isDirectory() ? filesUnder(p) : [p];
}) : []);

interface Inner {
	out: string;
	secretsBase: string;
	secret: string;
	code: number | null;
	signal: string | null;
	output: string;
}

const temps: string[] = [];

const runInner = async (mode: 'kill' | 'finish'): Promise<Inner> => {
	const base = mkdtempSync(join(tmpdir(), 'nst-c1r2-'));
	temps.push(base);
	const out = join(base, 'run');
	const secretsBase = join(base, 'tmp');
	const registryDir = join(secretsBase, `nst-secrets-${randomBytes(4).toString('hex')}`);
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const registry = join(registryDir, 'secrets.jsonl');
	writeFileSync(registry, '', { mode: 0o600 });
	const secret = `nstc1r2${randomBytes(12).toString('hex')}`;
	const ready = join(base, 'ready');
	const env: NodeJS.ProcessEnv = {
		...process.env, FORCE_COLOR: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
		NST_C1R2_OUT: out, NST_C1R2_SECRET: secret, NST_C1R2_READY: ready, NST_C1R2_MODE: mode, NOTESTEAD_SECRETS_FILE: registry,
	};
	for (const key of ['CI', 'JEST_WORKER_ID', 'NODE_OPTIONS', 'NST_SELFTEST_OUT', 'NST_SELFTEST_SECRET_FEED', 'NOTESTEAD_E2E_STACK']) delete env[key];
	const child = spawn('corepack', ['yarn', 'playwright', 'test', '-c', 'tests/harness/playwright.c1r2.config.ts'], { cwd: repoRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout?.on('data', (d: Buffer) => { output += d.toString('utf8'); });
	child.stderr?.on('data', (d: Buffer) => { output += d.toString('utf8'); });
	const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
	if (mode === 'kill') {
		await waitFor('the inner test to write its trace and signal ready', async () => (existsSync(ready) ? true : undefined), { timeoutMs: 2 * minute });
		if (child.pid) process.kill(-child.pid, 'SIGKILL');
	}
	const { code, signal } = await exited;
	return { out, secretsBase, secret, code, signal, output };
};

const leaks = (inner: Inner): string[] => filesUnder(inner.out).filter(f => textViews(f, readFileSync(f)).some(v => v.text.includes(inner.secret))).map(f => relative(inner.out, f));

const gate = (inner: Inner): { code: number | null; output: string } => {
	const r = spawnSync(process.execPath, ['tests/harness/upload-gate.ts', '--root', inner.out, '--secrets-dir', inner.secretsBase], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * minute });
	return { code: r.status, output: `${r.stdout}${r.stderr}` };
};

describe('C1-R2 a killed Playwright run never leaves an uploadable secret', () => {
	afterAll(() => {
		for (const t of temps) rmSync(t, { recursive: true, force: true });
	});

	test('c1r2-killed after SIGKILL the trace is unredacted (NEG control); after the upload gate no file holds the secret', async () => {
		const inner = await runInner('kill');
		const before = leaks(inner);
		expect({ signal: inner.signal, pending: existsSync(join(inner.out, pendingMarker)), complete: existsSync(join(inner.out, completeMarker)), leaked: before.length > 0 })
			.toEqual({ signal: 'SIGKILL', pending: true, complete: false, leaked: true });
		const g = gate(inner);
		expect({ code: g.code, leaks: leaks(inner) }).toEqual({ code: 0, leaks: [] });
		expect(JSON.parse(readFileSync(join(inner.out, 'upload-gate.json'), 'utf8')) as unknown).toMatchObject({ runs: [expect.objectContaining({ complete: false })] });
	}, 5 * minute);

	test('c1r2-finished positive control: a run that finishes marks its redaction complete, its trace is already clean, and the gate keeps it', async () => {
		const inner = await runInner('finish');
		expect({ code: inner.code, complete: existsSync(join(inner.out, completeMarker)), leaks: leaks(inner), tail: inner.code === 1 ? 'ok' : inner.output.slice(-2000) })
			.toEqual({ code: 1, complete: true, leaks: [], tail: 'ok' });
		const traces = filesUnder(join(inner.out, 'output')).filter(f => f.endsWith('trace.zip'));
		const g = gate(inner);
		expect({ code: g.code, kept: traces.every(f => existsSync(f)), traces: traces.length > 0 }).toEqual({ code: 0, kept: true, traces: true });
	}, 5 * minute);
});
