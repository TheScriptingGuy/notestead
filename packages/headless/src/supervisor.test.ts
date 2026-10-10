import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeResult } from './probes.ts';
import { exitCodes, pidOneWarning, runSupervisor } from './supervisor.ts';
import type { Supervisor } from './supervisor.ts';

const fakeCli = join(__dirname, 'testing', 'fake-joplin.mjs');
const syncPassword = 'nstsyncpw0123 Δ$x!';
const masterPassword = 'nstmasterpw0123 Δ$x!';

const validEnv = (): NodeJS.ProcessEnv => ({ JOPLIN_SERVER_URL: 'http://web:8089/joplin-server', JOPLIN_USERNAME: 'u@example.com', PATH: process.env.PATH });
const isPidOneWarning = (line: string): boolean => /\bPID 1\b/.test(line) && /\binit\b/.test(line);

const freePort = (): Promise<number> => new Promise(resolve => {
	const server = createServer();
	server.listen(0, '127.0.0.1', () => {
		const { port } = server.address() as AddressInfo;
		server.close(() => resolve(port));
	});
});

describe('runSupervisor', () => {
	let dir: string;
	let secretsDir: string;
	let profileDir: string;
	let lines: string[];
	let exits: number[];
	let supervisor: Supervisor | null;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'headless-supervisor-'));
		secretsDir = join(dir, 'secrets');
		profileDir = join(dir, 'data', 'profile');
		mkdirSync(secretsDir);
		writeFileSync(join(secretsDir, 'joplin_password'), `${syncPassword}\n`);
		writeFileSync(join(secretsDir, 'e2ee_master_password'), masterPassword);
		lines = [];
		exits = [];
		supervisor = null;
	});

	afterEach(async () => {
		await supervisor?.shutdown(0);
		rmSync(dir, { recursive: true, force: true });
	});

	const start = async (pingTarget: () => Promise<ProbeResult>, env: NodeJS.ProcessEnv = validEnv(), pid = 4242): Promise<Supervisor | null> => runSupervisor({
		env,
		pid,
		cliBinPath: fakeCli,
		secretsDir,
		profileDir,
		healthHost: '127.0.0.1',
		healthPort: 0,
		dataApiPort: await freePort(),
		retryDelayMs: 20,
		pingTarget,
		write: line => lines.push(line),
		exit: code => exits.push(code),
	});

	const healthz = async (s: Supervisor): Promise<{ status: number; body: unknown }> => {
		const res = await fetch(`http://127.0.0.1:${(s.health.address() as AddressInfo).port}/healthz`);
		return { status: res.status, body: await res.json() };
	};

	test('answers 503 while the sync target is down, 200 ready once the CLI cycle succeeded; no secret is logged', async () => {
		let targetUp = false;
		let refused: () => void = () => {};
		const sawRefusal = new Promise<void>(resolve => {
			refused = resolve;
		});
		supervisor = await start(async () => {
			if (targetUp) return { ok: true, detail: 'ok' };
			refused();
			return { ok: false, detail: 'ECONNREFUSED' };
		});
		const s = supervisor as Supervisor;
		expect(await healthz(s)).toEqual({ status: 503, body: { state: 'starting' } });
		await sawRefusal;
		expect(await healthz(s)).toEqual({ status: 503, body: { state: 'starting' } });
		targetUp = true;
		await s.started;
		const ready = await healthz(s);
		expect(ready.status).toBe(200);
		expect(ready.body).toEqual({ state: 'ready', lastSync: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) });

		expect(statSync(profileDir).mode & 0o777).toBe(0o700);
		const imported = JSON.parse(readFileSync(join(profileDir, 'imported.json'), 'utf8'));
		expect(imported).toMatchObject({ 'sync.9.password': syncPassword, 'encryption.masterPassword': masterPassword, 'api.port': expect.any(Number) });
		const calls = readFileSync(join(profileDir, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
		expect(calls.map(c => c.command.join(' '))).toEqual(['config --import', 'sync', 'e2ee decrypt --force', 'server start --quiet']);
		expect(calls[0].stdin).toMatch(/^(fifo|socket)$/);
		for (const c of calls) expect(c.env).toEqual(['PATH']);

		const log = lines.join('\n');
		for (const secret of [syncPassword, masterPassword, imported['api.token']]) expect(log.includes(secret)).toBe(false);
		expect(log).toContain('initial cycle failed: the sync target did not answer /api/ping before the sync (ECONNREFUSED)');
		expect(log).toContain('ready: Data API up on 127.0.0.1:');
		expect(lines.filter(isPidOneWarning)).toEqual([]);

		await s.shutdown(0);
		expect(exits).toEqual([0]);
	});

	test('as PID 1 it logs one warning naming PID 1 and init, first, and carries on to ready', async () => {
		supervisor = await start(async () => ({ ok: true, detail: 'ok' }), validEnv(), 1);
		const s = supervisor as Supervisor;
		await s.started;
		expect((await healthz(s)).status).toBe(200);
		const warnings = lines.filter(isPidOneWarning);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z /);
		expect(warnings[0].endsWith(pidOneWarning)).toBe(true);
		expect(lines[0]).toBe(warnings[0]);
		expect(exits).toEqual([]);
	});

	test('a configuration error exits 64 before anything starts, naming the variable only', async () => {
		supervisor = await start(async () => ({ ok: true, detail: 'ok' }), { JOPLIN_SERVER_URL: `http://u:${syncPassword}@web:8089`, JOPLIN_USERNAME: 'u' });
		expect(supervisor).toBeNull();
		expect(exits).toEqual([exitCodes.config]);
		expect(lines.join('\n')).toContain('configuration error: JOPLIN_SERVER_URL must not contain credentials');
		expect(lines.join('\n').includes(syncPassword)).toBe(false);
	});
});
