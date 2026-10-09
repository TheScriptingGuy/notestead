// The headless supervisor (ADR-0003): configuration → health endpoint → SyncStrategy. It owns one CLI profile and
// runs the CLI only as its direct children. Every log line passes the Redactor (ADR-0008).
import { chmodSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { CliRunner } from './cliRunner.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { SupervisorConfig } from './config.ts';
import { startHealthServer } from './healthServer.ts';
import type { ProbeResult } from './probes.ts';
import { Redactor } from './redact.ts';
import { StopTheWorldStrategy } from './stopTheWorldStrategy.ts';
import type { SyncStrategy } from './syncStrategy.ts';

export const defaults = {
	profileDir: '/data/profile',
	healthHost: '0.0.0.0',
	healthPort: 8090,
	// api.port: the CLI binds it on 127.0.0.1 only (ADR-0006: unreachable from outside the container).
	dataApiPort: 41184,
};

// sysexits(3), as the web entrypoint uses: 64 = bad configuration, 73 = cannot create the profile.
export const exitCodes = { config: 64, cantCreate: 73, serverExited: 1 };

// ADR-0006: the container runs a reaping init as PID 1 (`podman run --init`, compose `init: true`). Without one the
// supervisor is PID 1 and CLI children it stopped are never reaped (zombies that hang the sync cycle, spike S3/S4).
// It says so once and carries on, since some runtimes provide an init in other ways.
export const pidOneWarning = 'warning: running as PID 1 without an init; start the container with --init (compose: init: true) so that stopped CLI children are reaped';

export interface SupervisorOptions {
	env: NodeJS.ProcessEnv;
	cliBinPath: string;
	nodePath?: string;
	secretsDir?: string;
	profileDir?: string;
	healthHost?: string;
	healthPort?: number;
	dataApiPort?: number;
	// This process's pid (default process.pid); 1 means no init runs in the container.
	pid?: number;
	retryDelayMs?: number;
	pingTarget?: () => Promise<ProbeResult>;
	// Raw output sink; lines are redacted before they get here.
	write: (line: string) => void;
	// Called once when the supervisor wants the process to end with `code`.
	exit: (code: number) => void;
}

export interface Supervisor {
	strategy: SyncStrategy;
	health: Server;
	redactor: Redactor;
	// Resolves when the initial cycle has succeeded (or the supervisor is shutting down).
	started: Promise<void>;
	shutdown: (code?: number) => Promise<void>;
}

export const runSupervisor = async (options: SupervisorOptions): Promise<Supervisor | null> => {
	const redactor = new Redactor();
	const log = (line: string): void => options.write(`${new Date().toISOString()} ${redactor.redact(line)}`);
	if ((options.pid ?? process.pid) === 1) log(pidOneWarning);

	let config: SupervisorConfig;
	try {
		config = loadConfig(options.env, options.secretsDir);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		log(`configuration error: ${error.message}`);
		options.exit(exitCodes.config);
		return null;
	}
	redactor.addSecret(config.syncPassword);
	redactor.addSecret(config.masterPassword);

	const profileDir = options.profileDir ?? defaults.profileDir;
	try {
		mkdirSync(profileDir, { recursive: true, mode: 0o700 });
		chmodSync(profileDir, 0o700);
	} catch (error) {
		log(`cannot create the CLI profile ${profileDir} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
		options.exit(exitCodes.cantCreate);
		return null;
	}

	const cli = new CliRunner({ nodePath: options.nodePath ?? process.execPath, binPath: options.cliBinPath, profileDir, redactor, log, env: options.env });
	let shuttingDown: Promise<void> | null = null;
	let health: Server | null = null;
	const shutdown = (code = 0): Promise<void> => {
		if (!shuttingDown) {
			shuttingDown = (async () => {
				log(`shutting down (exit ${code})`);
				await strategy.stop();
				await new Promise<void>(resolve => (health ? health.close(() => resolve()) : resolve()));
				options.exit(code);
			})();
		}
		return shuttingDown;
	};
	const strategy = new StopTheWorldStrategy({
		cli,
		config,
		profileDir,
		dataApiPort: options.dataApiPort ?? defaults.dataApiPort,
		redactor,
		log,
		retryDelayMs: options.retryDelayMs,
		pingTarget: options.pingTarget,
		onServerExit: () => void shutdown(exitCodes.serverExited),
	});

	const host = options.healthHost ?? defaults.healthHost;
	const port = options.healthPort ?? defaults.healthPort;
	health = await startHealthServer({ host, port, status: () => strategy.status() });
	const address = health.address();
	log(`health endpoint on ${host}:${typeof address === 'object' && address ? address.port : port}; sync target ${config.serverUrl} as ${config.username}`);

	const started = strategy.start();
	return { strategy, health, redactor, started, shutdown };
};
