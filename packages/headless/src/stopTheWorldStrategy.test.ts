import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliExit, CliProcess } from './cliRunner.ts';
import type { SupervisorConfig } from './config.ts';
import type { ProbeResult } from './probes.ts';
import { Redactor } from './redact.ts';
import { StopTheWorldStrategy } from './stopTheWorldStrategy.ts';
import type { StopTheWorldOptions } from './stopTheWorldStrategy.ts';

const config: SupervisorConfig = { serverUrl: 'http://web:8089/joplin-server', username: 'u@example.com', syncPassword: 'sync pw Δ', masterPassword: 'master pw Δ' };
const completed = ['Starting synchronisation...', 'Completed: 05/10/2026 18:15 (6s)'];
const up: ProbeResult = { ok: true, detail: 'ok' };
const refused: ProbeResult = { ok: false, detail: 'ECONNREFUSED' };

interface Call {
	command: string;
	input?: string;
}

// A scripted CLI: `exits` maps a command to the exits of its successive runs (the last one repeats). `server start`
// stays running until stopped unless its scripted exit says otherwise.
class FakeCli {
	public calls: Call[] = [];
	public server: { exit: (e: CliExit) => void; running: boolean } | null = null;
	private exits_: Record<string, CliExit[]>;

	public constructor(exits: Record<string, CliExit[]> = {}) {
		this.exits_ = exits;
	}

	public start(command: string[], input?: string): CliProcess {
		const name = command.join(' ');
		this.calls.push({ command: name, ...(input === undefined ? {} : { input }) });
		const scripted = this.exits_[name] ?? [];
		const next = scripted.length > 1 ? scripted.shift() as CliExit : scripted[0];
		if (name === 'server start --quiet' && !next) {
			let resolveExit: (e: CliExit) => void = () => {};
			const exited = new Promise<CliExit>(resolve => {
				resolveExit = resolve;
			});
			const handle = { running: true, exit: (e: CliExit) => {
				handle.running = false;
				resolveExit(e);
			} };
			this.server = handle;
			return { pid: 1, exited, isRunning: () => handle.running, stop: async () => {
				handle.exit({ code: null, signal: 'SIGTERM', output: [] });
				return exited;
			} };
		}
		const exit = next ?? { code: 0, signal: null, output: name === 'sync' ? completed : [] };
		return { pid: 1, exited: Promise.resolve(exit), isRunning: () => false, stop: async () => exit };
	}
}

describe('StopTheWorldStrategy (initial cycle)', () => {
	let profile: string;
	let logged: string[];

	beforeEach(() => {
		profile = mkdtempSync(join(tmpdir(), 'headless-stw-'));
		logged = [];
	});

	afterEach(() => {
		rmSync(profile, { recursive: true, force: true });
	});

	const make = (cli: FakeCli, extra: Partial<StopTheWorldOptions> = {}): { strategy: StopTheWorldStrategy; redactor: Redactor } => {
		const redactor = new Redactor();
		const strategy = new StopTheWorldStrategy({
			cli,
			config,
			profileDir: profile,
			dataApiPort: 41184,
			redactor,
			log: line => logged.push(line),
			retryDelayMs: 0,
			pingTarget: async () => up,
			pingApi: async () => (cli.server?.running ? up : refused),
			newToken: () => 'a'.repeat(64),
			now: () => new Date('2026-10-05T18:15:07.000Z'),
			...extra,
		});
		return { strategy, redactor };
	};

	test('imports the settings on stdin, syncs, decrypts, serves, then reports ready with lastSync', async () => {
		const cli = new FakeCli();
		const { strategy, redactor } = make(cli);
		expect(strategy.status()).toEqual({ state: 'starting' });
		await strategy.start();
		expect(cli.calls.map(c => c.command)).toEqual(['config --import', 'sync', 'e2ee decrypt --force', 'server start --quiet']);
		expect(JSON.parse(cli.calls[0].input as string)).toEqual({
			'sync.target': 9,
			'sync.9.path': 'http://web:8089/joplin-server',
			'sync.9.username': 'u@example.com',
			'sync.9.password': 'sync pw Δ',
			'encryption.masterPassword': 'master pw Δ',
			'api.token': 'a'.repeat(64),
			'api.port': 41184,
			'locale': 'en_GB',
		});
		expect(cli.calls.slice(1).every(c => c.input === undefined)).toBe(true);
		expect(strategy.status()).toEqual({ state: 'ready', lastSync: '2026-10-05T18:15:07.000Z' });
		expect(redactor.redact(`token ${'a'.repeat(64)}`)).toBe('token [redacted]');
		await strategy.stop();
		expect(cli.server?.running).toBe(false);
		expect(strategy.status().state).toBe('stopping');
	});

	test('the default token is 32 random bytes, fresh per strategy', async () => {
		const tokens: string[] = [];
		for (let i = 0; i < 2; i++) {
			const cli = new FakeCli();
			const { strategy } = make(cli, { newToken: undefined });
			await strategy.start();
			tokens.push(JSON.parse(cli.calls[0].input as string)['api.token']);
			await strategy.stop();
		}
		expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
		expect(tokens[1]).not.toBe(tokens[0]);
	});

	test('negative control: while the sync target refuses connections no sync runs and the state stays "starting"', async () => {
		const cli = new FakeCli();
		let pings = 0;
		const { strategy } = make(cli, { pingTarget: async () => {
			pings++;
			if (pings >= 3) void strategy.stop();
			return refused;
		} });
		await strategy.start();
		expect(cli.calls.map(c => c.command)).toEqual(['config --import']);
		expect(strategy.status().state).not.toBe('ready');
		expect(logged.filter(l => l.startsWith('initial cycle failed: the sync target did not answer /api/ping before the sync (ECONNREFUSED)'))).toHaveLength(2);
	});

	test('a sync that exits 0 but reports an error, or whose target vanished, is retried; ready only after a good one', async () => {
		const cli = new FakeCli({
			sync: [
				{ code: 0, signal: null, output: ['Completed: x (1s) Last error: Error: 403 Forbidden'] },
				{ code: 0, signal: null, output: ['Completed: x (112s)'] },
				{ code: 0, signal: null, output: completed },
			],
		});
		const probes = [up, up, up, refused, up, up];
		const { strategy } = make(cli, { pingTarget: async () => probes.shift() ?? up });
		await strategy.start();
		expect(cli.calls.map(c => c.command)).toEqual(['config --import', 'sync', 'sync', 'sync', 'e2ee decrypt --force', 'server start --quiet']);
		expect(logged.filter(l => l.startsWith('initial cycle failed'))).toEqual([
			'initial cycle failed: sync reported an error: Error: 403 Forbidden; retrying in 0 s',
			'initial cycle failed: the sync target did not answer /api/ping after the sync (ECONNREFUSED); retrying in 0 s',
		]);
		expect(strategy.status().state).toBe('ready');
		await strategy.stop();
	});

	test('a failed decrypt is not ready (no master key loaded: exit 1)', async () => {
		const cli = new FakeCli({ 'e2ee decrypt --force': [{ code: 1, signal: null, output: ['DecryptionWorker: cannot start because no master key is currently loaded.'] }, { code: 0, signal: null, output: [] }] });
		const { strategy } = make(cli);
		await strategy.start();
		expect(logged).toContain('initial cycle failed: e2ee decrypt exited with code 1; retrying in 0 s');
		expect(cli.calls.map(c => c.command)).toEqual(['config --import', 'sync', 'e2ee decrypt --force', 'sync', 'e2ee decrypt --force', 'server start --quiet']);
		await strategy.stop();
	});

	test('a failed import is retried before any sync', async () => {
		const cli = new FakeCli({ 'config --import': [{ code: 1, signal: null, output: [] }, { code: 0, signal: null, output: [] }] });
		const { strategy } = make(cli);
		await strategy.start();
		expect(cli.calls.map(c => c.command)).toEqual(['config --import', 'config --import', 'sync', 'e2ee decrypt --force', 'server start --quiet']);
		await strategy.stop();
	});

	test('a server that exits before the Data API answers is not ready, and is retried', async () => {
		const cli = new FakeCli({ 'server start --quiet': [{ code: 3, signal: null, output: [] }, undefined as unknown as CliExit] });
		const { strategy } = make(cli);
		await strategy.start();
		expect(logged).toContain('initial cycle failed: Data API: server start exited before the Data API answered; retrying in 0 s');
		expect(strategy.status().state).toBe('ready');
		await strategy.stop();
	});

	test('when the server exits after ready, the state drops back and onServerExit is called', async () => {
		const cli = new FakeCli();
		const exits: CliExit[] = [];
		const { strategy } = make(cli, { onServerExit: e => exits.push(e) });
		await strategy.start();
		cli.server?.exit({ code: 1, signal: null, output: [] });
		await new Promise(resolve => setImmediate(resolve));
		expect(strategy.status().state).toBe('starting');
		expect(exits).toEqual([{ code: 1, signal: null, output: [] }]);
		expect(logged).toContain('server start exited with code 1; the Data API is down');
	});

	test('log-clipper.txt is emptied before the server starts (ADR-0008)', async () => {
		writeFileSync(join(profile, 'log-clipper.txt'), 'Request: GET /notes?token=old\n');
		const cli = new FakeCli();
		const { strategy } = make(cli);
		await strategy.start();
		expect(readFileSync(join(profile, 'log-clipper.txt'), 'utf8')).toBe('');
		await strategy.stop();
	});
});
