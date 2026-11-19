// M2-S4 D8 (docs/test-plans/M2-S4.md): E2E tests that need the internet carry `{ tag: '@network' }`, and playwright.config.ts
// leaves them out unless NOTESTEAD_NETWORK_TESTS=1. NT-01 and NT-02 prove both directions of that exclusion; NT-03 (CC-NET) is
// the CI half e2e.yml runs them nightly and on pin bumps.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { repoRoot } from '../support/repo.mts';

const listTests = (networkTests: string): { status: number | null; stdout: string; stderr: string } => {
	const r = spawnSync('corepack', ['yarn', 'playwright', 'test', '--list'], {
		cwd: repoRoot, encoding: 'utf8', timeout: 5 * 60_000, env: { ...process.env, NOTESTEAD_NETWORK_TESTS: networkTests },
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('M2-S4 D8: @network tests stay out of the default run', () => {
	it('NT-01 without NOTESTEAD_NETWORK_TESTS the list has the M2-AC9 tests and no @network test', () => {
		const r = listTests('');
		assert.equal(r.status, 0, `playwright test --list exited ${r.status}: ${r.stderr.slice(0, 500)}`);
		for (const id of ['M2-AC9-01', 'M2-AC9-02', 'M2-AC9-03']) assert.ok(r.stdout.includes(id), `${id} is listed`);
		const hits = r.stdout.split('\n').filter(l => l.includes('@network') || l.includes('M2-AC10'));
		assert.deepEqual(hits, [], 'no @network test or M2-AC10 is listed by default');
	});

	it('NT-02 with NOTESTEAD_NETWORK_TESTS=1 the list has M2-AC10 too', () => {
		const r = listTests('1');
		assert.equal(r.status, 0, `playwright test --list exited ${r.status}: ${r.stderr.slice(0, 500)}`);
		assert.ok(r.stdout.includes('M2-AC10'), 'M2-AC10 is listed when NOTESTEAD_NETWORK_TESTS=1');
	});

	// CC-NET (docs/test-plans/M2-S4.md, Brief CC-NET): red until e2e.yml carries the schedule, the dispatch input and the step output.
	it('NT-03 e2e.yml runs @network tests nightly, on demand and on pin bumps, on both runners', () => {
		const path = join(repoRoot, '.github', 'workflows', 'e2e.yml');
		assert.ok(existsSync(path), '.github/workflows/e2e.yml does not exist');
		const doc = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		const on = (doc.on ?? doc['true']) as Record<string, unknown> | undefined;
		const schedule = on?.schedule;
		assert.ok(Array.isArray(schedule) && schedule.length > 0 && (schedule as { cron?: unknown }[]).every(e => typeof e?.cron === 'string'), 'on.schedule is a non-empty list with a cron');
		const dispatch = on?.workflow_dispatch as { inputs?: { network?: { type?: unknown } } } | null | undefined;
		assert.equal(dispatch?.inputs?.network?.type, 'boolean', 'on.workflow_dispatch.inputs.network.type is boolean');

		interface Step { id?: string; run?: string; env?: Record<string, unknown> }
		const jobs = Object.entries((doc.jobs ?? {}) as Record<string, { 'runs-on'?: unknown; strategy?: unknown; steps?: Step[] }>);
		const playwrightJobs = jobs.filter(([, job]) => (job.steps ?? []).some(s => /\bplaywright\s+test\b/.test(s.run ?? '')));
		assert.ok(playwrightJobs.length > 0, 'a job runs `playwright test`');
		for (const [id, job] of playwrightJobs) {
			const steps = job.steps ?? [];
			const network = steps.find(s => s.id === 'network');
			assert.ok(network, `job "${id}" has a step with id: network`);
			assert.ok((network.run ?? '').includes('upstream/joplin-version.json') && (network.run ?? '').includes('schedule'), `job "${id}": the network step reads upstream/joplin-version.json and the schedule event`);
			for (const s of steps.filter(x => /\bplaywright\s+test\b/.test(x.run ?? ''))) {
				const value = String(s.env?.NOTESTEAD_NETWORK_TESTS ?? '');
				assert.ok(/\$\{\{.*steps\.network\.outputs.*\}\}/.test(value), `job "${id}": the Playwright step sets NOTESTEAD_NETWORK_TESTS from steps.network.outputs (got "${value}")`);
			}
		}
	});
});
