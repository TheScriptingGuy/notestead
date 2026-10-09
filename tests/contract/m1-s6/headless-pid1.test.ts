// Follow-up F3 (review M1-S5-r1 finding 4; ADR-0006 "a reaping init as PID 1"): the supervisor logs one warning at
// startup when it runs as PID 1 (the image started without --init / compose `init: true`), and keeps running (some
// runtimes inject an init differently). Positive control: with --init, PID 1 is the init, and there is no warning.
// The compose test stack sets `init: true` (tests/stack/compose.headless.yaml; checked by ac18). docs/test-plans/M1-S6.md.
import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headlessImage } from '../support/headless.ts';
import { containerLogs, containerState, podman, redact, repoRoot, runId, runLabel, testLabel, waitFor } from '../support/podman.ts';

const minute = 60_000;
const pidOneWarning = (line: string): boolean => /\bPID 1\b/i.test(line) && /\binit\b/i.test(line);

interface Started {
	name: string;
	secrets: string;
	volume: string;
}

const started: Started[] = [];

const start = (label: string, init: boolean): Started => {
	const image = headlessImage();
	const secrets = mkdtempSync(join(tmpdir(), 'm1s6-pid1-'));
	writeFileSync(join(secrets, 'joplin_password'), 'nst-pid1-password\n', { mode: 0o444 });
	writeFileSync(join(secrets, 'e2ee_master_password'), 'nst-pid1-master', { mode: 0o444 });
	const name = `nst-pid1-${label}-${runId()}`;
	// The profile volume (a fresh named volume inherits /data's owner, as in M1-S5); the root filesystem is read-only.
	const volume = `${name}-data`;
	podman(['volume', 'create', '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, volume]);
	// No network at all: the supervisor's sync never succeeds, so it stays up answering /healthz with 503.
	podman(['run', '-d', '--name', name, '--network', 'none', '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`,
		...(init ? ['--init'] : []), '--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--memory', '768m',
		'-v', `${volume}:/data`,
		'-v', `${join(secrets, 'joplin_password')}:/run/secrets/joplin_password:ro,Z`,
		'-v', `${join(secrets, 'e2ee_master_password')}:/run/secrets/e2ee_master_password:ro,Z`,
		'-e', 'JOPLIN_SERVER_URL=http://web:8089/joplin-server', '-e', 'JOPLIN_USERNAME=pid1@example.com', image]);
	const s = { name, secrets, volume };
	started.push(s);
	return s;
};

const exec = (name: string, script: string): string => podman(['exec', name, 'node', '-e', script], { allowFail: true }).stdout;

// /healthz answers (any status): the supervisor is past its startup.
const healthzAnswers = async (name: string): Promise<string> => waitFor(`${name} /healthz to answer`, async () => {
	const out = exec(name, "fetch('http://127.0.0.1:8090/healthz').then(r=>process.stdout.write(String(r.status)),()=>{})");
	return /^\d{3}$/.test(out) ? out : undefined;
}, {
	timeoutMs: 3 * minute,
	failFast: () => (containerState(name).status === 'running' ? undefined : `${name} exited: ${redact(containerLogs(name)).slice(-1500)}`),
});

// PID 1's argv (NUL-separated in /proc/1/cmdline).
const pidOne = (name: string): string[] => JSON.parse(exec(name, "process.stdout.write(JSON.stringify(require('fs').readFileSync('/proc/1/cmdline','utf8').split('\\0').filter(Boolean)))") || '[]') as string[];
const isSupervisor = (argv: string[]): boolean => /(^|\/)node$/.test(argv[0] ?? '') && argv.some(a => a.endsWith('/supervisor.ts'));

describe('F3 supervisor warns when it runs as PID 1', () => {
	afterEach(() => {
		const logs = join(repoRoot, 'test-results', 'contract', 'm1-s6');
		mkdirSync(logs, { recursive: true });
		for (const s of started.splice(0)) {
			writeFileSync(join(repoRoot, 'test-results', 'contract', 'm1-s6', `${s.name}.log`), redact(containerLogs(s.name)));
			podman(['rm', '-f', '-t', '0', s.name], { allowFail: true });
			podman(['volume', 'rm', '-f', s.volume], { allowFail: true });
			rmSync(s.secrets, { recursive: true, force: true });
		}
	});

	test('pid1-neg without --init the supervisor is PID 1, logs exactly one warning naming PID 1 and init, and keeps running', async () => {
		const s = start('noinit', false);
		await healthzAnswers(s.name);
		expect({ pid1: pidOne(s.name), supervisor: isSupervisor(pidOne(s.name)) }).toEqual({ pid1: expect.any(Array), supervisor: true });
		const warnings = containerLogs(s.name).split('\n').filter(pidOneWarning);
		expect(warnings).toHaveLength(1);
		expect(containerState(s.name).status).toBe('running');
	}, 10 * minute);

	test('pid1-pos with --init PID 1 is the init and there is no warning', async () => {
		const s = start('init', true);
		await healthzAnswers(s.name);
		// An init (podman's catatonit as /run/podman-init) is PID 1 and runs the supervisor as its child.
		expect({ pid1: pidOne(s.name), supervisor: isSupervisor(pidOne(s.name)) }).toEqual({ pid1: expect.arrayContaining([expect.stringMatching(/init|tini/)]), supervisor: false });
		expect(containerLogs(s.name).split('\n').filter(pidOneWarning)).toEqual([]);
	}, 10 * minute);
});
