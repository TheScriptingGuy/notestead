// M1-AC8: `corepack yarn check:workflows [--dir <workflows-dir>]` runs the pinned actionlint plus the repo's pipeline
// security rules (sha-pin, permissions, pull-request-target) over the workflows, and the repository's own
// `.github/workflows/*.yml` pass. Test plan: docs/test-plans/M1-S3.md (§Command contract).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, assertOutputIncludes, describeRun, ensureInstalled, gitStatus, makeTempDir,
	placeTemporarily, removeDir, repoRoot, requireRootScript, yarnScript,
} from '../support/repo.mts';
import type { RunOptions, RunResult } from '../support/repo.mts';
import {
	applyEdits, caseFixture, isPinnedUses, makeWorkflowTree, readText, someLineHasAll, usesValues, validActionFixture,
	validWorkflowFixture, workflowCases, workflowFixtures, writeExecutable,
} from '../support/workflows.mts';

const story = 'm1-s3';
const minute = 60_000;
const acNegCase = 'sha-pin--checkout-v7.yml';
const contract = 'docs/test-plans/M1-S3.md §Command contract';

let installed = false;
const checkWorkflows = (label: string, args: string[] = [], opts: RunOptions = {}): RunResult => {
	if (!installed) {
		ensureInstalled(story);
		installed = true;
	}
	// The first run may download and verify the pinned actionlint (see the contract), so allow for the network.
	return yarnScript(story, label, 'check:workflows', args, { timeoutMs: 4 * minute, ...opts }, contract);
};

const temps: string[] = [];
after(() => temps.forEach(removeDir));
const tree = (prefix: string, workflows: { name: string; from: string }[], actionFrom?: string): string => {
	const t = makeWorkflowTree(`m1s3-${prefix}`, workflows, actionFrom);
	temps.push(t.root);
	return t.workflowsDir;
};
const validTree = (prefix: string): string => tree(prefix, [{ name: 'valid.yml', from: validWorkflowFixture }]);

const assertReported = (r: RunResult, needles: string[], why: string): void => {
	assert.ok(someLineHasAll(r, needles), `${why}: expected one output line containing all of ${JSON.stringify(needles)}. ${describeRun(r)}`);
};

describe('M1-AC8 fixtures (harness self-checks)', () => {
	it('M1-S3-T00 every invalid fixture is the valid fixture plus exactly its declared edits; the AC NEG and every rule are covered', () => {
		const committed = readdirSync(join(workflowFixtures, 'invalid')).filter(f => f.endsWith('.fixture')).sort();
		assert.deepEqual(committed, workflowCases.map(c => `${c.file}.fixture`).sort(), 'committed invalid fixtures = declared cases');
		for (const c of workflowCases) {
			const valid = readText(c.target === 'workflow' ? validWorkflowFixture : validActionFixture);
			assert.equal(readText(caseFixture(c)), applyEdits(valid, c.edits, c.file), `${c.file} must equal the valid fixture with its declared edits`);
		}
		assert.ok(workflowCases.some(c => c.file === acNegCase && c.needles.includes('actions/checkout@v7')), 'the M1-AC8 NEG case (actions/checkout@v7) exists');
		for (const rule of ['[sha-pin]', '[permissions]', '[pull-request-target]', '[job-needs]']) {
			assert.ok(workflowCases.some(c => c.needles.includes(rule)), `a case expects ${rule}`);
		}
		// The independent pin scanner used by T11 agrees with the fixtures (so T11 cannot pass by accident).
		assert.deepEqual(usesValues(readText(validWorkflowFixture)).filter(u => !isPinnedUses(u)), [], 'valid workflow: all uses pinned');
		assert.deepEqual(usesValues(readText(validActionFixture)).filter(u => !isPinnedUses(u)), [], 'valid action: all uses pinned');
		for (const c of workflowCases.filter(x => x.needles.includes('[sha-pin]'))) {
			assert.ok(usesValues(readText(caseFixture(c))).some(u => !isPinnedUses(u)), `${c.file}: the scanner sees the unpinned uses`);
		}
	});
});

describe('M1-AC8 check:workflows on fixture trees (--dir)', () => {
	it('M1-S3-T01 positive control: the valid workflow and composite action pass, and the actionlint version is printed', { timeout: 5 * minute }, () => {
		const r = checkWorkflows('T01-valid', ['--dir', validTree('valid')]);
		assertExitZero(r);
		assertOutputIncludes(r, /actionlint\D{0,40}\d+\.\d+\.\d+/i, 'check:workflows must print the actionlint version it runs');
	});

	for (const c of workflowCases) {
		const id = c.file === acNegCase ? 'M1-S3-T02 (M1-AC8 NEG)' : 'M1-S3-T03';
		it(`${id} ${c.file} → non-zero, reports ${c.needles.filter(n => n.startsWith('[')).join(' ')} (${c.why})`, { timeout: 5 * minute }, () => {
			const dir = c.target === 'workflow'
				? tree(`case-${c.file}`, [{ name: c.file, from: caseFixture(c) }])
				: tree(`case-${c.file}`, [{ name: 'valid.yml', from: validWorkflowFixture }], caseFixture(c));
			const r = checkWorkflows(`T0x-${c.file}`, ['--dir', dir]);
			assertExitNonZero(r);
			assertReported(r, c.needles, c.why);
		});
	}

	it('M1-S3-T04 every offending file is reported, not only the first', { timeout: 5 * minute }, () => {
		const dir = tree('multi', [
			{ name: 'valid.yml', from: validWorkflowFixture },
			{ name: 'sha-pin--checkout-v7.yml', from: join(workflowFixtures, 'invalid', 'sha-pin--checkout-v7.yml.fixture') },
			{ name: 'permissions--job-missing.yml', from: join(workflowFixtures, 'invalid', 'permissions--job-missing.yml.fixture') },
		]);
		const r = checkWorkflows('T04-multi', ['--dir', dir]);
		assertExitNonZero(r);
		assertReported(r, ['sha-pin--checkout-v7.yml', '[sha-pin]', 'actions/checkout@v7'], 'first offending file');
		assertReported(r, ['permissions--job-missing.yml', '[permissions]', 'arm-job'], 'second offending file');
	});

	it('M1-S3-T05 a directory without workflow files fails (never a vacuous pass), naming the directory', { timeout: 5 * minute }, () => {
		const empty = makeTempDir('m1s3-empty');
		temps.push(empty);
		const r = checkWorkflows('T05-empty-dir', ['--dir', empty]);
		assertExitNonZero(r);
		assertOutputIncludes(r, empty, 'the message must name the directory');
	});
});

describe('M1-AC8 actionlint is the pinned binary, and results do not depend on the machine', () => {
	it('M1-S3-T06 ACTIONLINT pointing at a missing binary fails clearly, naming the path', { timeout: 5 * minute }, () => {
		const base = makeTempDir('m1s3-no-actionlint');
		temps.push(base);
		const missing = join(base, 'nowhere', 'actionlint');
		const r = checkWorkflows('T06-actionlint-missing', ['--dir', validTree('t06')], { env: { ACTIONLINT: missing } });
		assertExitNonZero(r);
		assertOutputIncludes(r, missing, 'the message must name the missing actionlint path');
	});

	it('M1-S3-T07 an actionlint of another version is refused, naming that version (Pi and CI must get the same findings)', { timeout: 5 * minute }, () => {
		const bin = makeTempDir('m1s3-fake-actionlint');
		temps.push(bin);
		// Reports a wrong version and never finds anything: if it is used without the version check, T07 sees exit 0.
		const fake = writeExecutable(bin, 'actionlint', [
			'#!/bin/sh',
			'# Fake actionlint planted by the M1-S3 tests (wrong version, no findings).',
			'case "$1" in -version|--version) printf \'0.0.1\\ninstalled by the M1-S3 tests (fake)\\n\';; esac',
			'exit 0',
			'',
		].join('\n'));
		const r = checkWorkflows('T07-actionlint-wrong-version', ['--dir', validTree('t07')], { env: { ACTIONLINT: fake } });
		assertExitNonZero(r);
		assertOutputIncludes(r, '0.0.1', 'the message must name the version found');
	});

	it('M1-S3-T08 a shellcheck planted on PATH does not change the result (shellcheck is pinned or disabled)', { timeout: 5 * minute }, () => {
		const bin = makeTempDir('m1s3-fake-shellcheck');
		temps.push(bin);
		// Reports one error on every script. actionlint picks shellcheck up from PATH unless told otherwise.
		writeExecutable(bin, 'shellcheck', [
			'#!/bin/sh',
			'# Fake shellcheck planted on PATH by the M1-S3 tests.',
			'cat >/dev/null',
			'echo \'[{"file":"-","line":1,"endLine":1,"column":1,"endColumn":2,"level":"error","code":9999,"message":"planted shellcheck from PATH"}]\'',
			'exit 1',
			'',
		].join('\n'));
		const r = checkWorkflows('T08-planted-shellcheck', ['--dir', validTree('t08')], { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } });
		assertExitZero(r);
		assert.ok(!r.output.includes('SC9999'), `the planted shellcheck was used. ${describeRun(r)}`);
	});
});

// ---- The repository's own workflows ----

const workflowsDir = join(repoRoot, '.github', 'workflows');
const actionsDir = join(repoRoot, '.github', 'actions');
const isYaml = (f: string): boolean => /\.ya?ml$/.test(f);
const walk = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap(e => {
	const p = join(dir, e);
	return statSync(p).isDirectory() ? walk(p) : [p];
});
const scopes = 'actions|attestations|checks|contents|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|repository-projects|security-events|statuses';

describe('M1-AC8 the repository workflows', () => {
	it('M1-S3-T10 `corepack yarn check:workflows` (defaults: .github/workflows) exits 0', { timeout: 5 * minute }, () => {
		for (const f of ['ci.yml', 'web-bundle.yml']) assert.ok(existsSync(join(workflowsDir, f)), `M1-S3 goal: .github/workflows/${f} does not exist`);
		assertExitZero(checkWorkflows('T10-repo'));
	});

	it('M1-S3-T11 data check, independent of the checker: every uses is pinned, no *-all permissions, ci/web-bundle grant no write scope, no actionlint ignores', () => {
		for (const f of ['ci.yml', 'web-bundle.yml']) assert.ok(existsSync(join(workflowsDir, f)), `M1-S3 goal: .github/workflows/${f} does not exist`);
		const workflows = readdirSync(workflowsDir).filter(isYaml).map(f => join(workflowsDir, f));
		const actions = walk(actionsDir).filter(p => /(^|\/)action\.ya?ml$/.test(p));
		const offenders: string[] = [];
		for (const file of [...workflows, ...actions]) {
			for (const u of usesValues(readText(file))) if (!isPinnedUses(u)) offenders.push(`${relative(repoRoot, file)}: ${u}`);
		}
		assert.deepEqual(offenders, [], 'every uses: is local (./), docker:// by sha256 digest, or owner/repo[/path]@<40-hex commit>');
		for (const file of workflows) {
			const text = readText(file);
			assert.ok(!/^\s*permissions\s*:\s*['"]?(write-all|read-all)\b/m.test(text), `${relative(repoRoot, file)} uses write-all or read-all`);
		}
		for (const f of ['ci.yml', 'web-bundle.yml']) {
			const text = readText(join(workflowsDir, f));
			assert.ok(usesValues(text).length > 0, `${f} uses no action at all (expected at least a pinned checkout)`);
			const writes = text.split('\n').filter(l => new RegExp(`^\\s*(${scopes})\\s*:\\s*['"]?write\\b`).test(l));
			assert.deepEqual(writes, [], `${f}: lint, test, build and artifact upload need no write scope (least privilege; raise a dispute with the reason if a job does)`);
		}
		for (const f of ['actionlint.yaml', 'actionlint.yml']) {
			const p = join(repoRoot, '.github', f);
			if (existsSync(p)) assert.ok(!/^\s*ignore\s*:/m.test(readFileSync(p, 'utf8')), `.github/${f} must not ignore findings`);
		}
	});

	it('M1-S3-T12 (M1-AC8 NEG, default mode) a workflow with actions/checkout@v7 placed in .github/workflows fails `check:workflows`', { timeout: 5 * minute }, () => {
		requireRootScript('check:workflows', contract);
		const before = gitStatus();
		const name = 'zz-qa-m1s3-neg-checkout-v7.yml';
		const cleanup = placeTemporarily([{ from: join(workflowFixtures, 'invalid', `${acNegCase}.fixture`), to: join(workflowsDir, name) }]);
		let r: RunResult;
		try {
			r = checkWorkflows('T12-repo-with-checkout-v7');
		} finally {
			cleanup();
		}
		assert.equal(gitStatus(), before, 'the temporary workflow was removed');
		assertExitNonZero(r);
		assertReported(r, [name, '[sha-pin]', 'actions/checkout@v7'], 'the M1-AC8 NEG in the default directory');
	});
});
