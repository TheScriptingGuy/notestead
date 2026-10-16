// M1-AC30 to M1-AC32 (review M1-S3-r1 C1 to C3): the `check:workflows` hardening that lands before `e2e.yml`.
// - M1-AC30: YAML aliases cannot bypass [sha-pin] and [permissions] (resolved first, or rejected as [yaml-alias]), and
//   a job or step that is not a mapping is reported as [workflow-shape], never skipped.
// - M1-AC31: the pull_request_target and workflow_run triggers are banned outright as [forbidden-trigger].
// - M1-AC32: every local `uses: ./<path>` is resolved to <root>/<path>/action.y{a,}ml and checked like
//   .github/actions/**; a missing one is [local-action].
// Each NEG is an invalid fixture (the valid M1-S3 fixture plus declared edits) that must fail with its rule ID and the
// file path; the valid fixtures keep passing (M1-S3 T01, and the local-action positive control below).
// Test plan: docs/test-plans/M1-S8.md §check:workflows.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertExitNonZero, assertExitZero, describeRun, ensureInstalled, removeDir, yarnScript } from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';
import {
	applyEdits, hardeningCases, hardeningFixture, hardeningFixtures, makeTreeWithExtras, matchesExpectation, readText,
	validActionFixture, validLocalActionCase, validWorkflowFixture, workflowFixtures,
} from '../support/workflows.mts';

const story = 'm1-s8';
const minute = 60_000;
const contract = 'docs/test-plans/M1-S8.md §check:workflows';

let installed = false;
const checkWorkflows = (label: string, args: string[]): RunResult => {
	if (!installed) {
		ensureInstalled(story);
		installed = true;
	}
	return yarnScript(story, label, 'check:workflows', args, { timeoutMs: 4 * minute }, contract);
};

const temps: string[] = [];
after(() => temps.forEach(removeDir));

describe('M1-S8 check:workflows hardening fixtures (harness self-checks)', () => {
	it('M1-S8-W00 every fixture is a valid M1-S3 fixture plus exactly its declared edits; every AC and rule is covered', () => {
		const committed = readdirSync(join(hardeningFixtures, 'invalid')).filter(f => f.endsWith('.fixture')).sort();
		assert.deepEqual(committed, hardeningCases.map(c => `${c.file}.fixture`).sort(), 'committed invalid fixtures = declared cases');
		for (const c of hardeningCases) {
			const valid = readText(c.target === 'workflow' ? validWorkflowFixture : validActionFixture);
			assert.equal(readText(hardeningFixture(c)), applyEdits(valid, c.edits, c.file), `${c.file} must equal the valid fixture with its declared edits`);
		}
		assert.equal(readText(hardeningFixture(validLocalActionCase, 'valid')), applyEdits(readText(validWorkflowFixture), validLocalActionCase.edits, validLocalActionCase.file));
		for (const ac of ['M1-AC30', 'M1-AC31', 'M1-AC32']) assert.ok(hardeningCases.some(c => c.ac === ac), `a case covers ${ac}`);
		const needles = hardeningCases.flatMap(c => c.expect.flat(2));
		for (const rule of ['[yaml-alias]', '[workflow-shape]', '[forbidden-trigger]', '[local-action]', '[sha-pin]', '[permissions]']) {
			assert.ok(needles.includes(rule), `a case expects ${rule}`);
		}
		for (const trigger of ['pull_request_target', 'workflow_run']) {
			assert.ok(hardeningCases.some(c => c.ac === 'M1-AC31' && readText(hardeningFixture(c)).includes(trigger)), `an M1-AC31 fixture uses ${trigger}`);
		}
	});
});

describe('M1-S8 check:workflows on fixture trees (--dir)', () => {
	for (const c of hardeningCases) {
		const rules = [...new Set(c.expect.flat(2).filter(n => n.startsWith('[')))].join(' or ');
		it(`M1-S8-W-${c.id} (${c.ac} NEG) ${c.file} → non-zero, reports ${rules} with the file path (${c.why})`, { timeout: 5 * minute }, () => {
			const tree = c.target === 'workflow'
				? makeTreeWithExtras(`m1s8-${c.id}`, [{ name: c.file, from: hardeningFixture(c) }], validActionFixture, c.extra)
				: makeTreeWithExtras(`m1s8-${c.id}`, [{ name: 'valid.yml', from: validWorkflowFixture }], hardeningFixture(c), c.extra);
			temps.push(tree.root);
			const r = checkWorkflows(`W-${c.id}`, ['--dir', tree.workflowsDir]);
			assertExitNonZero(r);
			assert.ok(matchesExpectation(r, c.expect),
				`${c.why}: expected, for one alternative, every needle group on one output line: ${JSON.stringify(c.expect)}. ${describeRun(r)}`);
		});
	}

	it('M1-S8-W-ac32-pos (M1-AC32 positive control) a valid local action outside .github/actions/ (action.yaml) passes', { timeout: 5 * minute }, () => {
		const tree = makeTreeWithExtras('m1s8-ac32-pos', [{ name: validLocalActionCase.file, from: hardeningFixture(validLocalActionCase, 'valid') }], validActionFixture, validLocalActionCase.extra);
		temps.push(tree.root);
		const r = checkWorkflows('W-ac32-pos', ['--dir', tree.workflowsDir]);
		assertExitZero(r);
	});

	it('M1-S8-W-ac32-both (M1-AC32) the evil action is reported even when the workflow that uses it is otherwise valid, and the valid composite action under .github/actions/ is still checked', { timeout: 5 * minute }, () => {
		const evil = hardeningCases.find(c => c.id === 'ac32-evil');
		assert.ok(evil);
		// The .github/actions/setup action of this tree has a tag-pinned step too: both local actions must be reported.
		const tree = makeTreeWithExtras('m1s8-ac32-both', [{ name: evil.file, from: hardeningFixture(evil) }], join(workflowFixtures, 'invalid', 'sha-pin--composite-setup-node-tag.action.yml.fixture'), evil.extra);
		temps.push(tree.root);
		const r = checkWorkflows('W-ac32-both', ['--dir', tree.workflowsDir]);
		assertExitNonZero(r);
		assert.ok(matchesExpectation(r, [[['tools/evil/action.yml', '[sha-pin]'], ['.github/actions/setup/action.yml', '[sha-pin]']]]), `both local actions must be reported. ${describeRun(r)}`);
	});
});
