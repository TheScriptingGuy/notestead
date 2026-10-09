// M1-S6 follow-up F1 (review M1-S1-r1 C2; ADR-0007 "ESLint bans page.waitForTimeout, setTimeout-based sleeps in
// tests"): `corepack yarn lint` must also reject setTimeout-based sleeps in test files, in every form below, while the
// harness's one polling primitive (tests/support/poll.ts), the in-container sampler fixtures and real deadlines stay
// allowed. One lint run with every fixture in place. Test plan: docs/test-plans/M1-S6.md.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	assertExitNonZero, describeRun, fixturesDir, gitStatus, lintReported, placeTemporarily, repoRoot, requireRootScript,
	workspacePackages, yarnScript,
} from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';

const story = 'm1-s6';
const minute = 60_000;
const lintFixtures = join(fixturesDir, 'm1-s6', 'lint');
// Any of ESLint's restriction rules may implement the ban.
const banRules = ['no-restricted-syntax', 'no-restricted-imports', 'no-restricted-globals', 'no-restricted-properties'];

interface Placed {
	id: string;
	fixture: string;
	to: string;
}

describe('F1 lint rejects setTimeout-based sleeps in tests (one lint run)', () => {
	let result: RunResult | undefined;
	let cleanup: (() => void) | undefined;
	let statusBefore: string | undefined;
	let negatives: Placed[] = [];
	const positive: Placed = { id: 'allowed', fixture: 'allowed.test.ts.fixture', to: 'tests/unit/__lint_neg_s6__/allowed.test.ts' };

	before(() => {
		requireRootScript('lint');
		const pkg = workspacePackages().find(w => existsSync(join(w.dir, 'src')));
		assert.ok(pkg, 'no workspace package has a src/ directory to host the package-level lint fixture');
		negatives = [
			{ id: 'promise', fixture: 'sleep-promise.test.ts.fixture', to: 'tests/unit/__lint_neg_s6__/sleep-promise.test.ts' },
			{ id: 'timers-promises', fixture: 'sleep-timers.spec.ts.fixture', to: 'tests/e2e/__lint_neg_s6__/sleep-timers.spec.ts' },
			{ id: 'timers-promises-bare', fixture: 'sleep-timers-bare.test.ts.fixture', to: `${pkg.rel}/src/__lint_neg_s6__/sleep-timers-bare.test.ts` },
			{ id: 'callback', fixture: 'sleep-callback.test.ts.fixture', to: 'tests/contract/__lint_neg_s6__/sleep-callback.test.ts' },
			{ id: 'globalThis', fixture: 'sleep-global.spec.ts.fixture', to: 'tests/harness/__lint_neg_s6__/sleep-global.spec.ts' },
			{ id: 'mts', fixture: 'sleep.test.mts.fixture', to: 'tests/acceptance/__lint_neg_s6__/sleep.test.mts' },
		];
		statusBefore = gitStatus();
		cleanup = placeTemporarily([...negatives, positive].map(p => ({ from: join(lintFixtures, p.fixture), to: join(repoRoot, p.to) })));
		result = yarnScript(story, 'F1-lint-sleeps', 'lint', [], { timeoutMs: 10 * minute });
	});

	after(() => {
		cleanup?.();
		if (statusBefore !== undefined) assert.equal(gitStatus(), statusBefore, 'lint fixtures were not cleaned up');
	});

	const lintRun = (): RunResult => {
		assert.ok(result, 'lint did not run (see the before hook)');
		return result;
	};

	it('F1-T01 lint exits non-zero with the sleep fixtures in place', () => {
		assertExitNonZero(lintRun());
	});

	for (const id of ['promise', 'timers-promises', 'timers-promises-bare', 'callback', 'globalThis', 'mts']) {
		it(`F1-T02-${id} the ${id} sleep is reported by a restriction rule`, () => {
			const r = lintRun();
			const placed = negatives.find(n => n.id === id);
			assert.ok(placed);
			assert.ok(banRules.some(rule => lintReported(r.output, placed.to, rule)), `no ${banRules.join('/')} report for ${placed.to}. ${describeRun(r)}`);
		});
	}

	it('F1-T03 positive control: polling, deadlines and fake timers are not reported, nor is any other file of the repository', () => {
		const r = lintRun();
		// Files with problems (stylish formatter: an absolute path on its own line).
		const reported = r.output.split('\n').filter(l => /^\/\S+$/.test(l.trim()) && l.startsWith('/')).map(l => relative(repoRoot, l.trim()));
		const expected = negatives.map(n => n.to).sort();
		assert.deepEqual([...new Set(reported)].sort(), expected, `lint reported other files than the sleep fixtures (the harness's tests/support/poll.ts and the sampler fixtures must stay allowed). ${describeRun(r)}`);
		assert.ok(!reported.includes(positive.to), `the positive control ${positive.to} was reported. ${describeRun(r)}`);
	});
});
