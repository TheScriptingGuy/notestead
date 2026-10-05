// The default SyncStrategy (ADR-0003 Decision 2), in its M1-S5 form: one initial cycle, then serve.
//   1. `config --import` with the settings and secrets as JSON on stdin, and a fresh 32-byte `api.token` (ADR-0008);
//   2. `sync`, judged by public signals (syncOutcome.ts), because the CLI exits 0 when a sync fails;
//   3. `e2ee decrypt --force` (exit code 0 required: it exits 1 when no master key is loaded);
//   4. `server start --quiet`, then wait for the Data API's `/ping` on 127.0.0.1.
// A failed attempt is logged and retried after a fixed delay, with the state left at `starting`; M3 replaces this
// with the cycle loop, backoff and the `degraded` state (M3-AC1).
import { randomBytes } from 'node:crypto';
import { existsSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import type { CliExit, CliProcess } from './cliRunner.ts';
import type { SupervisorConfig } from './config.ts';
import { pingDataApi, pingSyncTarget, waitUntilReady } from './probes.ts';
import type { ProbeResult } from './probes.ts';
import type { Redactor } from './redact.ts';
import { judgeSync } from './syncOutcome.ts';
import type { SyncStatus, SyncStrategy } from './syncStrategy.ts';

export interface CliLike {
	start(command: string[], input?: string): CliProcess;
}

export interface StopTheWorldOptions {
	cli: CliLike;
	config: SupervisorConfig;
	profileDir: string;
	dataApiPort: number;
	redactor: Redactor;
	log: (line: string) => void;
	// Called when `server start` exits while the strategy isn't stopping (the Data API is gone).
	onServerExit?: (exit: CliExit) => void;
	retryDelayMs?: number;
	apiReadyTimeoutMs?: number;
	pingTarget?: () => Promise<ProbeResult>;
	pingApi?: () => Promise<ProbeResult>;
	newToken?: () => string;
	now?: () => Date;
}

// Joplin Server (ADR-0002: through web's internal listener).
export const joplinServerSyncTarget = 9;

// The settings `config --import` applies on every start (idempotent). `locale` is fixed so the sync report the
// supervisor reads (`Completed: …`, `Last error: …`) is in English whatever LANG the container has.
export const importSettings = (config: SupervisorConfig, apiToken: string, apiPort: number): Record<string, string | number> => ({
	'sync.target': joplinServerSyncTarget,
	'sync.9.path': config.serverUrl,
	'sync.9.username': config.username,
	'sync.9.password': config.syncPassword,
	'encryption.masterPassword': config.masterPassword,
	'api.token': apiToken,
	'api.port': apiPort,
	'locale': 'en_GB',
});

const describeExit = (exit: CliExit): string => (exit.error ? `could not be started (${exit.error})` : exit.code === null ? `ended by signal ${exit.signal}` : `exited with code ${exit.code}`);

export class StopTheWorldStrategy implements SyncStrategy {
	private options_: StopTheWorldOptions;
	private status_: SyncStatus = { state: 'starting' };
	private stopping_ = false;
	private imported_ = false;
	private current_: CliProcess | null = null;
	private server_: CliProcess | null = null;
	private wakeUp_: AbortController = new AbortController();

	public constructor(options: StopTheWorldOptions) {
		this.options_ = options;
	}

	public status(): SyncStatus {
		return { ...this.status_ };
	}

	public async start(): Promise<void> {
		const retryDelayMs = this.options_.retryDelayMs ?? 30_000;
		for (;;) {
			if (this.stopping_) return;
			const failure = await this.attempt();
			if (!failure) return;
			if (this.stopping_) return;
			this.options_.log(`initial cycle failed: ${failure}; retrying in ${Math.round(retryDelayMs / 1000)} s`);
			await this.pause(retryDelayMs);
		}
	}

	public async stop(): Promise<void> {
		this.stopping_ = true;
		this.status_ = { ...this.status_, state: 'stopping' };
		this.wakeUp_.abort();
		await this.current_?.stop();
		await this.server_?.stop();
	}

	// One attempt of the initial cycle. Returns the reason it failed, or null once the Data API is up.
	private async attempt(): Promise<string | null> {
		const { config, dataApiPort, redactor } = this.options_;
		const pingTarget = this.options_.pingTarget ?? (() => pingSyncTarget(config.serverUrl));
		const now = this.options_.now ?? (() => new Date());

		if (!this.imported_) {
			const token = (this.options_.newToken ?? (() => randomBytes(32).toString('hex')))();
			redactor.addSecret(token);
			const imported = await this.runCli(['config', '--import'], JSON.stringify(importSettings(config, token, dataApiPort)));
			if (imported.code !== 0) return `config --import ${describeExit(imported)}`;
			this.imported_ = true;
		}

		// No sync is started while the target doesn't answer (it would retry for minutes and still exit 0).
		const before = await pingTarget();
		if (!before.ok) return `the sync target did not answer /api/ping before the sync (${before.detail})`;
		if (this.stopping_) return 'stopping';
		const synced = await this.runCli(['sync']);
		const syncEnded = now();
		const after = await pingTarget();
		const verdict = judgeSync({ before, run: synced, after });
		if (!verdict.ok) return verdict.reason;

		if (this.stopping_) return 'stopping';
		const decrypted = await this.runCli(['e2ee', 'decrypt', '--force']);
		if (decrypted.code !== 0) return `e2ee decrypt ${describeExit(decrypted)}`;

		if (this.stopping_) return 'stopping';
		const failure = await this.startServer();
		if (failure) return failure;

		this.status_ = { state: 'ready', lastSync: syncEnded.toISOString() };
		this.options_.log(`ready: Data API up on 127.0.0.1:${dataApiPort}, last sync ${this.status_.lastSync}`);
		return null;
	}

	private async startServer(): Promise<string | null> {
		const { dataApiPort, profileDir } = this.options_;
		// ADR-0008: the CLI logs every request URL, token included, to log-clipper.txt; start each server with an empty
		// file (the token rotates on every start, so older tokens are useless anyway).
		const clipperLog = join(profileDir, 'log-clipper.txt');
		if (existsSync(clipperLog)) truncateSync(clipperLog);

		const server = this.options_.cli.start(['server', 'start', '--quiet']);
		this.server_ = server;
		try {
			await waitUntilReady(this.options_.pingApi ?? (() => pingDataApi(dataApiPort)), {
				timeoutMs: this.options_.apiReadyTimeoutMs ?? 120_000,
				abortIf: () => {
					if (this.stopping_) return 'stopping';
					return server.isRunning() ? undefined : 'server start exited before the Data API answered';
				},
			});
		} catch (error) {
			await server.stop();
			this.server_ = null;
			return `Data API: ${(error as Error).message}`;
		}
		void server.exited.then(exit => {
			if (this.stopping_) return;
			this.status_ = { ...this.status_, state: 'starting' };
			this.options_.log(`server start ${describeExit(exit)}; the Data API is down`);
			this.options_.onServerExit?.(exit);
		});
		return null;
	}

	private async runCli(command: string[], input?: string): Promise<CliExit> {
		const child = this.options_.cli.start(command, input);
		this.current_ = child;
		try {
			return await child.exited;
		} finally {
			this.current_ = null;
		}
	}

	// Waits between attempts; stop() ends the wait at once.
	private async pause(ms: number): Promise<void> {
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, ms);
			this.wakeUp_.signal.addEventListener('abort', () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		});
	}
}
