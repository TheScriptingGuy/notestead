// M2-S4 D8 (docs/test-plans/M2-S4.md): E2E tests that need the internet carry `{ tag: '@network' }`, and playwright.config.ts
// leaves them out unless NOTESTEAD_NETWORK_TESTS=1. NT-01 and NT-02 prove both directions of that exclusion; NT-03 (CC-NET) is
// the CI half (added with WO-6): e2e.yml runs them nightly and on pin bumps.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
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

});
