// Runs the pinned Joplin CLI as direct child processes of the supervisor (ADR-0003 Decision 1): always
// `node <cli bin> --profile <profile> <command…>`, with input (if any) on a stdin pipe, never in argv or env.
// Every output line is redacted before it is relayed to the supervisor's log. Children are reaped by Node; the
// container's init (`--init`) reaps anything orphaned.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Redactor } from './redact.ts';

export interface CliExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	// The redacted output lines (stdout and stderr, interleaved as received), at most `maxLines` of the last ones.
	output: string[];
	// A spawn failure (for example a missing binary), if any.
	error?: string;
}

export interface CliProcess {
	pid: number | undefined;
	exited: Promise<CliExit>;
	isRunning: () => boolean;
	// SIGTERM, then SIGKILL if the process hasn't exited after `graceMs`. Resolves when it has exited.
	stop: (graceMs?: number) => Promise<CliExit>;
}

export interface CliRunnerOptions {
	nodePath: string;
	binPath: string;
	profileDir: string;
	redactor: Redactor;
	log: (line: string) => void;
	env?: NodeJS.ProcessEnv;
	maxLines?: number;
}

// The environment a CLI child gets: only what the CLI needs to run. The supervisor never puts secrets in its own
// environment either; the allow-list keeps it that way if an operator adds unrelated variables to the container.
const childEnvKeys = ['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'];

export const childEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
	const out: NodeJS.ProcessEnv = {};
	for (const key of childEnvKeys) {
		if (env[key] !== undefined) out[key] = env[key];
	}
	return out;
};

export class CliRunner {
	private options_: CliRunnerOptions;

	public constructor(options: CliRunnerOptions) {
		this.options_ = options;
	}

	public argv(command: string[]): string[] {
		return [this.options_.binPath, '--profile', this.options_.profileDir, ...command];
	}

	// Starts `command`; `input` (if given) is written to the child's stdin pipe, which is then closed.
	public start(command: string[], input?: string): CliProcess {
		const label = `[joplin ${command.filter(a => !a.startsWith('-')).join(' ')}]`;
		const maxLines = this.options_.maxLines ?? 200;
		const output: string[] = [];
		const child: ChildProcess = spawn(this.options_.nodePath, this.argv(command), {
			stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			env: childEnv(this.options_.env ?? process.env),
		});
		let running = true;
		let spawnError: string | undefined;
		const relay = (stream: Readable | null): Promise<void> => {
			if (!stream) return Promise.resolve();
			const lines = createInterface({ input: stream, crlfDelay: Infinity });
			lines.on('line', raw => {
				const line = this.options_.redactor.redact(raw);
				output.push(line);
				if (output.length > maxLines) output.shift();
				this.options_.log(`${label} ${line}`);
			});
			return new Promise(resolve => lines.on('close', resolve));
		};
		const streamsDone = Promise.all([relay(child.stdout), relay(child.stderr)]);
		const exited = new Promise<CliExit>(resolve => {
			let settled = false;
			const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
				if (settled) return;
				settled = true;
				running = false;
				void streamsDone.then(() => resolve({ code, signal, output: [...output], ...(spawnError ? { error: spawnError } : {}) }));
			};
			child.on('error', error => {
				spawnError = error.message;
				finish(null, null);
			});
			child.on('exit', finish);
		});
		if (input !== undefined && child.stdin) {
			child.stdin.on('error', () => {
				// The child exited before reading its input; its exit status reports the failure.
			});
			child.stdin.end(input);
		}
		const stop = async (graceMs = 10_000): Promise<CliExit> => {
			if (!running) return exited;
			child.kill('SIGTERM');
			const timer = setTimeout(() => {
				if (running) child.kill('SIGKILL');
			}, graceMs);
			try {
				return await exited;
			} finally {
				clearTimeout(timer);
			}
		};
		return { pid: child.pid, exited, isRunning: () => running, stop };
	}

	// Runs `command` to completion.
	public run(command: string[], input?: string): Promise<CliExit> {
		return this.start(command, input).exited;
	}
}
