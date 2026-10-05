import type { CliExit } from './cliRunner.ts';
import type { ProbeResult } from './probes.ts';
import { judgeSync } from './syncOutcome.ts';

const up: ProbeResult = { ok: true, detail: 'ok' };
const refused: ProbeResult = { ok: false, detail: 'ECONNREFUSED' };
const completed = ['Synchronisation target: Joplin Server (9)', 'Starting synchronisation...', 'Fetched items: 3/3. Completed: 05/10/2026 18:15 (6s)', 'Downloading resources...'];
const exit = (output: string[], code: number | null = 0): CliExit => ({ code, signal: code === null ? 'SIGKILL' : null, output });

describe('judgeSync', () => {
	test('a completed sync against a target that answered before and after is a success', () => {
		expect(judgeSync({ before: up, run: exit(completed), after: up })).toEqual({ ok: true });
	});

	test('negative control (CLI 3.7.1 finding): exit 0 and "Completed" while the target refuses connections is a failure', () => {
		// What `joplin sync` prints after ~2 min of retries against a refusing target: no error line at all.
		const refusedRun = exit(['Synchronisation target: Joplin Server (9)', 'Starting synchronisation...', 'Completed: 05/10/2026 18:15 (112s)']);
		expect(judgeSync({ before: up, run: refusedRun, after: refused })).toEqual({ ok: false, reason: 'the sync target did not answer /api/ping after the sync (ECONNREFUSED)' });
		expect(judgeSync({ before: refused, run: refusedRun, after: up }).ok).toBe(false);
	});

	test('a "Last error" line fails the sync even with exit 0', () => {
		const run = exit(['Starting synchronisation...', 'Completed: 05/10/2026 18:15 (1s) Last error: FetchError: request to http://web:8089/joplin-server/api/sessions failed, reason: connect ENETUNREACH']);
		expect(judgeSync({ before: up, run, after: up })).toEqual({ ok: false, reason: 'sync reported an error: FetchError: request to http://web:8089/joplin-server/api/sessions failed, reason: connect ENETUNREACH' });
	});

	test('a sync without the completion line fails (for example the per-profile lock was held)', () => {
		const run = exit(['Lock file is already being hold. If you know that no synchronisation is taking place, you may delete the lock file']);
		expect(judgeSync({ before: up, run, after: up })).toEqual({ ok: false, reason: 'sync did not report completion' });
	});

	test('a non-zero exit, a signal or a spawn error fails', () => {
		expect(judgeSync({ before: up, run: exit(completed, 1), after: up })).toEqual({ ok: false, reason: 'sync exited with code 1' });
		expect(judgeSync({ before: up, run: exit(completed, null), after: up })).toEqual({ ok: false, reason: 'sync exited with signal SIGKILL' });
		expect(judgeSync({ before: up, run: { ...exit([], null), error: 'spawn ENOENT' }, after: up })).toEqual({ ok: false, reason: 'sync could not be started (spawn ENOENT)' });
	});
});
