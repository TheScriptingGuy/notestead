// Did a `joplin sync` run succeed? CLI 3.7.1 doesn't say so reliably: `sync` exits 0 when the sync failed, and
// upstream drops "retryable" network errors (connection refused, timeouts) from the report, so a sync against a
// target that refuses every connection prints only `Completed: … (112s)` (docs/test-plans/M1-S5.md, findings).
// The verdict therefore combines public signals only, and fails closed:
//   1. the sync target answered its public `GET /api/ping` right before the sync and right after it;
//   2. the `sync` process exited with code 0;
//   3. its output has the report's completion line (`Completed: …`, the CLI runs with locale en_GB) and no
//      `Last error: …` line (non-retryable errors: authentication, HTTP errors, unreachable network, …).
// Residual gap: a target that drops out and comes back strictly within the sync window. Upstream-first: a non-zero
// exit status from `joplin sync` on any failure would replace rules 1 and 3 (docs/worklog/M1-S5.md).
import type { CliExit } from './cliRunner.ts';
import type { ProbeResult } from './probes.ts';

export interface SyncEvidence {
	before: ProbeResult;
	run: CliExit;
	after: ProbeResult;
}

export type SyncVerdict = { ok: true } | { ok: false; reason: string };

const completedLine = /(^|\s)Completed: /;
const lastErrorLine = /(^|\s)Last error: (.*)$/;

export const judgeSync = ({ before, run, after }: SyncEvidence): SyncVerdict => {
	if (!before.ok) return { ok: false, reason: `the sync target did not answer /api/ping before the sync (${before.detail})` };
	if (run.error) return { ok: false, reason: `sync could not be started (${run.error})` };
	if (run.code !== 0) return { ok: false, reason: `sync exited with ${run.code === null ? `signal ${run.signal}` : `code ${run.code}`}` };
	const lastError = run.output.map(line => lastErrorLine.exec(line)).filter(m => m !== null).pop();
	if (lastError) return { ok: false, reason: `sync reported an error: ${lastError[2].slice(0, 300)}` };
	if (!run.output.some(line => completedLine.test(line))) return { ok: false, reason: 'sync did not report completion' };
	if (!after.ok) return { ok: false, reason: `the sync target did not answer /api/ping after the sync (${after.detail})` };
	return { ok: true };
};
