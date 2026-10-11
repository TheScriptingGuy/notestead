// FU-S6a-1 (review M1-S6a-r1 FU-S6a-1 and C2-R5; ADR-0007 "ESLint bans … setTimeout-based sleeps in tests"), due in
// M1-S8 because this story touches the lint setup: `corepack yarn lint` must also reject the sleep forms the M1-S6a ban
// misses: setTimeout taken by member access from `require('node:timers')` and from a dynamic `import()` of the timers
// modules, `scheduler` (scheduler.wait) from node:timers/promises, and `Atomics.wait`. Each NEG fixture holds one form
// on the line marked `// NEG`, and that exact line must be reported by a restriction rule. Positive controls:
// `require`/`import()` of other modules with member access, Atomics without wait, non-test source using every banned
// form, and every other file of the repository. One lint run with every fixture in place.
// Test plan: docs/test-plans/M1-S8.md §FU-S6a-1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	assertExitNonZero, describeRun, fixturesDir, gitStatus, placeTemporarily, repoRoot, requireRootScript, yarnScript,
} from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';

const story = 'm1-s8';
const minute = 60_000;
const lintFixtures = join(fixturesDir, 'm1-s8', 'lint');
// Any of ESLint's restriction rules may implement the ban.
const banRules = ['no-restricted-syntax', 'no-restricted-imports', 'no-restricted-globals', 'no-restricted-properties'];

interface Placed {
	id: string;
	fixture: string;
	to: string;
}

interface LintMessage {
	file: string;
	line: number;
	rule: string;
}

// ESLint's stylish formatter: an absolute file path on its own line, then `  <line>:<col>  error  <message>  <rule>`.
const lintMessages = (output: string): LintMessage[] => {
	const messages: LintMessage[] = [];
	let file = '';
	for (const raw of output.split('\n')) {
		const line = raw.replace(/\s+$/, '');
		if (/^\/\S+$/.test(line)) {
			file = relative(repoRoot, line);
			continue;
		}
		const m = /^\s+(\d+):\d+\s+(?:error|warning)\s+.*?\s(\S+)$/.exec(line);
		if (m && file) messages.push({ file, line: Number.parseInt(m[1], 10), rule: m[2] });
	}
	return messages;
};

// 1-based numbers of the lines marked `// NEG` in a fixture.
const negLines = (fixture: string): number[] => readFileSync(join(lintFixtures, fixture), 'utf8').split('\n')
	.flatMap((l, i) => (/\/\/ NEG$/.test(l.trimEnd()) ? [i + 1] : []));

const negatives: Placed[] = [
	{ id: 'require', fixture: 'sleep-require-timers.test.ts.fixture', to: 'tests/unit/__lint_neg_s8__/sleep-require-timers.test.ts' },
	{ id: 'import', fixture: 'sleep-import-member.spec.ts.fixture', to: 'tests/e2e/__lint_neg_s8__/sleep-import-member.spec.ts' },
	{ id: 'scheduler', fixture: 'sleep-scheduler-wait.test.mts.fixture', to: 'tests/acceptance/__lint_neg_s8__/sleep-scheduler-wait.test.mts' },
	{ id: 'atomics', fixture: 'sleep-atomics-wait.test.ts.fixture', to: 'packages/headless/src/__lint_neg_s8__/sleep-atomics-wait.test.ts' },
];

const positives: Placed[] = [
	{ id: 'allowed-modules', fixture: 'allowed-modules.test.ts.fixture', to: 'tests/contract/__lint_pos_s8__/allowed-modules.test.ts' },
	{ id: 'non-test-source', fixture: 'timers-modules-source.ts.fixture', to: 'packages/headless/src/__lint_pos_s8__/timers-modules.ts' },
];

describe('FU-S6a-1 lint rejects timers taken from require()/import(), scheduler.wait and Atomics.wait in tests (one lint run)', () => {
	let result: RunResult | undefined;
	let cleanup: (() => void) | undefined;
	let statusBefore: string | undefined;

	before(() => {
		requireRootScript('lint');
		for (const n of negatives) assert.equal(negLines(n.fixture).length, 1, `fixture ${n.fixture} must mark exactly one line with // NEG`);
		statusBefore = gitStatus();
		cleanup = placeTemporarily([...negatives, ...positives].map(p => ({ from: join(lintFixtures, p.fixture), to: join(repoRoot, p.to) })));
		result = yarnScript(story, 'FU-S6a-1-lint-sleep-modules', 'lint', [], { timeoutMs: 10 * minute });
	});

	after(() => {
		cleanup?.();
		if (statusBefore !== undefined) assert.equal(gitStatus(), statusBefore, 'lint fixtures were not cleaned up');
	});

	const lintRun = (): RunResult => {
		assert.ok(result, 'lint did not run (see the before hook)');
		return result;
	};

	it('M1-S8-L01 lint exits non-zero, and eslint (not tsc) is why', () => {
		const r = lintRun();
		assertExitNonZero(r);
		assert.ok(lintMessages(r.output).some(m => banRules.includes(m.rule)), `no restriction-rule report at all. ${describeRun(r)}`);
	});

	for (const n of negatives) {
		it(`M1-S8-L02-${n.id} (FU-S6a-1 NEG) the ${n.id} form is reported by a restriction rule on its NEG line`, () => {
			const r = lintRun();
			const want = negLines(n.fixture);
			const got = lintMessages(r.output).filter(m => m.file === n.to && banRules.includes(m.rule)).map(m => m.line);
			assert.deepEqual(want.filter(l => !got.includes(l)), [], `${n.to}: NEG line(s) ${want.join(', ')} not reported by ${banRules.join('/')} (reported lines: ${got.join(', ') || 'none'}). ${describeRun(r)}`);
		});
	}

	it('M1-S8-L03-allowed positive controls: other modules through require()/import(), Atomics without wait, and non-test source are not reported', () => {
		const r = lintRun();
		const reported = lintMessages(r.output).filter(m => positives.some(p => p.to === m.file));
		assert.deepEqual(reported, [], `a positive control was reported. ${describeRun(r)}`);
	});

	it('M1-S8-L03-repo no other file of the repository is reported', () => {
		const r = lintRun();
		const files = [...new Set(lintMessages(r.output).map(m => m.file))].sort();
		const allowed = negatives.map(n => n.to);
		assert.deepEqual(files.filter(f => !allowed.includes(f)), [], `lint reported files other than the NEG fixtures. ${describeRun(r)}`);
	});

	it('M1-S8-L03-only-ban every report in a NEG fixture comes from a restriction rule (the fixtures are otherwise clean)', () => {
		const r = lintRun();
		const other = lintMessages(r.output).filter(m => negatives.some(n => n.to === m.file) && !banRules.includes(m.rule));
		assert.deepEqual(other, [], `a NEG fixture has an unrelated lint problem. ${describeRun(r)}`);
	});
});
