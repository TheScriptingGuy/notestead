// Fixtures and helpers for the workflow checks (M1-AC8, `corepack yarn check:workflows`). Test plan: docs/test-plans/M1-S3.md.
// Erasable TypeScript only: Node runs this file through built-in type stripping.
//
// The committed fixtures carry a `.fixture` suffix and live outside any `.github/` path, so neither GitHub, Dependabot,
// Renovate nor a code scanner treats them as live workflows. The tests copy them into a temp `.github/` tree.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixturesDir, makeTempDir } from './repo.mts';
import type { RunResult } from './repo.mts';

export const workflowFixtures = join(fixturesDir, 'm1-s3', 'workflows');
export const validWorkflowFixture = join(workflowFixtures, 'valid.yml.fixture');
export const validActionFixture = join(workflowFixtures, 'setup-action.yml.fixture');

const checkoutSha = '11bd71901bbe5b1630ceea73d27597364c9af683';
const dockerDigest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const reusableSha = '0123456789abcdef0123456789abcdef01234567';
const setupNodeSha = '49933ea5288caeca8642d1e84afbd3f7d6820020';

export type Edit = [from: string, to: string];

export interface WorkflowCase {
	// File name under tests/fixtures/m1-s3/workflows/invalid/ (without the `.fixture` suffix). Prefix = expected rule
	// (the two `pull-request-target--*` cases keep their M1-S3 names; since M1-S8 they expect [forbidden-trigger]).
	file: string;
	// Which valid fixture the case is derived from: the workflow, or the composite action it uses.
	target: 'workflow' | 'action';
	// Each `from` occurs exactly once in the valid fixture; the committed case file is the valid fixture with these edits.
	edits: Edit[];
	// Some single line of `check:workflows` output must contain every needle (file, rule ID, offending value).
	needles: string[];
	why: string;
}

const wf = (name: string): string => `${name}.yml`;

export const workflowCases: WorkflowCase[] = [
	{
		file: wf('sha-pin--checkout-v7'), target: 'workflow',
		edits: [[`      - uses: actions/checkout@${checkoutSha} # v4.2.2\n`, '      - uses: actions/checkout@v7\n']],
		needles: [wf('sha-pin--checkout-v7'), '[sha-pin]', 'actions/checkout@v7'],
		why: 'M1-AC8 NEG: a tag, not a commit SHA',
	},
	{
		file: wf('sha-pin--branch'), target: 'workflow',
		edits: [[`      - uses: actions/checkout@${checkoutSha} # v4.2.2\n`, '      - uses: actions/checkout@main\n']],
		needles: [wf('sha-pin--branch'), '[sha-pin]', 'actions/checkout@main'],
		why: 'a branch is mutable',
	},
	{
		file: wf('sha-pin--short-sha'), target: 'workflow',
		edits: [[`      - uses: actions/checkout@${checkoutSha} # v4.2.2\n`, '      - uses: actions/checkout@11bd719\n']],
		needles: [wf('sha-pin--short-sha'), '[sha-pin]', 'actions/checkout@11bd719'],
		why: 'a short SHA is not a full commit pin (and is ambiguous)',
	},
	{
		file: wf('sha-pin--docker-tag'), target: 'workflow',
		edits: [[`docker://alpine@${dockerDigest}`, 'docker://alpine:3.20']],
		needles: [wf('sha-pin--docker-tag'), '[sha-pin]', 'docker://alpine:3.20'],
		why: 'a docker:// action must be pinned by digest',
	},
	{
		file: wf('sha-pin--reusable-tag'), target: 'workflow',
		edits: [[`build.yml@${reusableSha}`, 'build.yml@v1']],
		needles: [wf('sha-pin--reusable-tag'), '[sha-pin]', 'octo-org/shared/.github/workflows/build.yml@v1'],
		why: 'a job-level reusable workflow is third-party code too',
	},
	{
		file: 'sha-pin--composite-setup-node-tag.action.yml', target: 'action',
		edits: [[`actions/setup-node@${setupNodeSha} # v4.4.0`, 'actions/setup-node@v4']],
		needles: ['action.yml', '[sha-pin]', 'actions/setup-node@v4'],
		why: 'steps of a local composite action run in the job too',
	},
	{
		file: wf('permissions--job-missing'), target: 'workflow',
		edits: [['    runs-on: ubuntu-24.04-arm\n    permissions:\n      contents: read\n', '    runs-on: ubuntu-24.04-arm\n']],
		needles: [wf('permissions--job-missing'), '[permissions]', 'arm-job'],
		why: 'every job declares its own permissions',
	},
	{
		file: wf('permissions--reusable-job-missing'), target: 'workflow',
		edits: [['    needs: arm-job\n    permissions:\n      contents: read\n', '    needs: arm-job\n']],
		needles: [wf('permissions--reusable-job-missing'), '[permissions]', 'shared-job'],
		why: 'a job that calls a reusable workflow declares permissions too',
	},
	{
		file: wf('permissions--job-write-all'), target: 'workflow',
		edits: [['    runs-on: ubuntu-24.04-arm\n    permissions:\n      contents: read\n', '    runs-on: ubuntu-24.04-arm\n    permissions: write-all\n']],
		needles: [wf('permissions--job-write-all'), '[permissions]', 'arm-job', 'write-all'],
		why: 'write-all is never least privilege',
	},
	{
		file: wf('permissions--job-read-all'), target: 'workflow',
		edits: [['    runs-on: ubuntu-24.04-arm\n    permissions:\n      contents: read\n', '    runs-on: ubuntu-24.04-arm\n    permissions: read-all\n']],
		needles: [wf('permissions--job-read-all'), '[permissions]', 'arm-job', 'read-all'],
		why: 'read-all grants every scope; name the scopes the job needs',
	},
	{
		file: wf('permissions--workflow-write-all'), target: 'workflow',
		edits: [['\npermissions: {}\n', '\npermissions: write-all\n']],
		needles: [wf('permissions--workflow-write-all'), '[permissions]', 'write-all'],
		why: 'no write-all at workflow level either',
	},
	{
		file: wf('pull-request-target--head-sha-checkout'), target: 'workflow',
		edits: [
			['  pull_request:\n', '  pull_request_target:\n'],
			[`      - uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n`, `      - uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`],
		],
		// M1-S8 (M1-AC31): the trigger itself is banned, so the rule is [forbidden-trigger] (was [pull-request-target]).
		needles: [wf('pull-request-target--head-sha-checkout'), '[forbidden-trigger]', 'pull_request_target'],
		why: 'pull_request_target runs with secrets; checking out the PR head runs untrusted code with them',
	},
	{
		file: wf('pull-request-target--head-ref-checkout'), target: 'workflow',
		edits: [
			['  pull_request:\n', '  pull_request_target:\n'],
			[`      - uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n`, `      - uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n          ref: \${{ github.head_ref }}\n`],
		],
		needles: [wf('pull-request-target--head-ref-checkout'), '[forbidden-trigger]', 'pull_request_target'],
		why: 'the same, through github.head_ref',
	},
	{
		file: wf('actionlint--needs-missing'), target: 'workflow',
		edits: [['    needs: build-job\n', '    needs: buidl-job\n']],
		needles: [wf('actionlint--needs-missing'), '[job-needs]', 'buidl-job'],
		why: 'a defect only actionlint finds: proves actionlint runs on every file and its exit status counts',
	},
];

export const caseFixture = (c: WorkflowCase): string => join(workflowFixtures, 'invalid', `${c.file}.fixture`);

export const applyEdits = (text: string, edits: Edit[], label: string): string => {
	let out = text;
	for (const [from, to] of edits) {
		const count = out.split(from).length - 1;
		assert.equal(count, 1, `${label}: the edit source must occur exactly once in the valid fixture, found ${count}: ${JSON.stringify(from)}`);
		out = out.replace(from, () => to);
	}
	return out;
};

export interface WorkflowTree {
	root: string;
	workflowsDir: string;
	actionFile: string;
}

// Builds <tmp>/.github/workflows/<name> (one entry per workflow) plus the composite action
// <tmp>/.github/actions/setup/action.yml that the valid workflow uses (`uses: ./.github/actions/setup`).
export const makeWorkflowTree = (prefix: string, workflows: { name: string; from: string }[], actionFrom: string = validActionFixture): WorkflowTree => {
	const root = makeTempDir(prefix);
	const workflowsDir = join(root, '.github', 'workflows');
	const actionDir = join(root, '.github', 'actions', 'setup');
	mkdirSync(workflowsDir, { recursive: true });
	mkdirSync(actionDir, { recursive: true });
	for (const w of workflows) copyFileSync(w.from, join(workflowsDir, w.name));
	const actionFile = join(actionDir, 'action.yml');
	copyFileSync(actionFrom, actionFile);
	return { root, workflowsDir, actionFile };
};

// Writes an executable shell script (a fake tool) and returns its path.
export const writeExecutable = (dir: string, name: string, script: string): string => {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return path;
};

// True when one output line contains every needle.
export const someLineHasAll = (r: RunResult, needles: string[]): boolean =>
	r.output.split('\n').some(line => needles.every(n => line.includes(n)));

export const readText = (path: string): string => readFileSync(path, 'utf8');

// `uses:` values in a workflow or action file, line-based and independent of the checker under test. Quotes and
// trailing comments are stripped. Flow-style mappings (`{ uses: … }`) are reported as-is so they fail the pin pattern.
export const usesValues = (text: string): string[] => {
	const out: string[] = [];
	for (const line of text.split('\n')) {
		const m = /^\s*(?:-\s+)?uses\s*:\s*(.+?)\s*$/.exec(line);
		if (!m) continue;
		out.push(m[1].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2'));
	}
	return out;
};

// The pin rule of the contract: local (`./…`), docker by digest, or owner/repo[/path]@<40 lowercase hex>.
export const isPinnedUses = (value: string): boolean =>
	value.startsWith('./')
	|| /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(value)
	|| /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(value);

// ---- M1-S8: the check:workflows hardening (M1-AC30 to M1-AC32; review M1-S3-r1 C1 to C3) ----
// docs/test-plans/M1-S8.md §check:workflows. The cases are edits of the same two valid M1-S3 fixtures. A case may add
// files to the tree (a local action outside .github/actions/), and its expectation is a list of alternatives: the
// check must exit non-zero and, for at least one alternative, every group of needles must occur on one output line
// (groups may share a line). Alternatives exist only where the AC lets the engineer choose (M1-AC30: resolve aliases,
// or reject them under [yaml-alias]).

export const hardeningFixtures = join(fixturesDir, 'm1-s8', 'workflows');

export interface ExtraFile {
	// path relative to the tree root (the directory that holds .github/)
	to: string;
	from: string;
}

export interface HardeningCase {
	id: string;
	ac: 'M1-AC30' | 'M1-AC31' | 'M1-AC32';
	// File name under tests/fixtures/m1-s8/workflows/invalid/ (without `.fixture`).
	file: string;
	target: 'workflow' | 'action';
	edits: Edit[];
	extra?: ExtraFile[];
	expect: string[][][];
	why: string;
}

const prt: Edit = ['  pull_request:\n', '  pull_request_target:\n'];
const buildCheckout = `      - uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n`;
const withRef = (ref: string): Edit => [buildCheckout, `${buildCheckout}          ref: ${ref}\n`];
const armSteps = `    steps:\n      - name: Check out\n        uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n          persist-credentials: false\n      - run: echo "tested"\n`;
const lastLine = `    uses: octo-org/shared/.github/workflows/build.yml@${reusableSha}\n`;
const evilAction = join(workflowFixtures, 'invalid', 'sha-pin--composite-setup-node-tag.action.yml.fixture');

export const hardeningCases: HardeningCase[] = [
	// M1-AC30 (C1): YAML aliases must not bypass [sha-pin] and [permissions]; non-mappings are reported, not skipped.
	{
		id: 'ac30-neg1', ac: 'M1-AC30', file: wf('alias--step-anchored-in-matrix'), target: 'workflow',
		edits: [
			['    runs-on: ubuntu-24.04-arm\n', '    runs-on: ubuntu-24.04-arm\n    strategy:\n      matrix:\n        include:\n          - s: &evil {uses: actions/checkout@v4}\n'],
			[armSteps, '    steps: [*evil]\n'],
		],
		expect: [
			[[wf('alias--step-anchored-in-matrix'), '[yaml-alias]']],
			[[wf('alias--step-anchored-in-matrix'), '[sha-pin]', 'actions/checkout@v4', 'arm-job']],
		],
		why: 'NEG 1: a step anchored in strategy.matrix.include and used as steps: [*evil]',
	},
	{
		id: 'ac30-neg2', ac: 'M1-AC30', file: wf('alias--job-anchored-in-matrix'), target: 'workflow',
		edits: [
			['    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-24.04\n    strategy:\n      matrix:\n        include:\n          - j: &job\n              runs-on: ubuntu-24.04\n              steps:\n                - uses: actions/checkout@v4\n'],
			[lastLine, `${lastLine}  aliased-job: *job\n`],
		],
		expect: [
			[[wf('alias--job-anchored-in-matrix'), '[yaml-alias]']],
			[
				[wf('alias--job-anchored-in-matrix'), '[permissions]', 'aliased-job'],
				[wf('alias--job-anchored-in-matrix'), '[sha-pin]', 'actions/checkout@v4', 'aliased-job'],
			],
		],
		why: 'NEG 2: a job `aliased-job: *job` whose anchor has a tag-pinned step and no permissions: (both rules must fire after resolution)',
	},
	{
		id: 'ac30-action-alias', ac: 'M1-AC30', file: 'alias--composite-step.action.yml', target: 'action',
		edits: [
			['runs:\n', 'x-evil: &evil {uses: actions/setup-node@v4}\nruns:\n'],
			[`    - uses: actions/setup-node@${setupNodeSha} # v4.4.0\n      with:\n        node-version: '22'\n`, '    - *evil\n'],
		],
		expect: [
			[['action.yml', '[yaml-alias]']],
			[['action.yml', '[sha-pin]', 'actions/setup-node@v4']],
		],
		why: 'the same hole in a composite action file (steps: [*evil])',
	},
	{
		id: 'ac30-scalar-step', ac: 'M1-AC30', file: wf('workflow-shape--scalar-step'), target: 'workflow',
		edits: [['      - run: echo "tested"\n', '      - echo "tested"\n']],
		expect: [[[wf('workflow-shape--scalar-step'), '[workflow-shape]', 'arm-job']]],
		why: 'a step that is not a mapping is reported, not skipped',
	},
	{
		id: 'ac30-scalar-job', ac: 'M1-AC30', file: wf('workflow-shape--scalar-job'), target: 'workflow',
		edits: [[lastLine, `${lastLine}  scalar-job: just-a-string\n`]],
		expect: [[[wf('workflow-shape--scalar-job'), '[workflow-shape]', 'scalar-job']]],
		why: 'a job that is not a mapping is reported, not skipped',
	},
	// M1-AC31 (C2): pull_request_target and workflow_run are banned outright, whatever the jobs do.
	{
		id: 'ac31-merge-commit-sha', ac: 'M1-AC31', file: wf('forbidden-trigger--prt-merge-commit-sha'), target: 'workflow',
		edits: [prt, withRef('${{ github.event.pull_request.merge_commit_sha }}')],
		expect: [[[wf('forbidden-trigger--prt-merge-commit-sha'), '[forbidden-trigger]', 'pull_request_target']]],
		why: 'the merge commit contains the pull request author\'s code',
	},
	{
		id: 'ac31-env-ref', ac: 'M1-AC31', file: wf('forbidden-trigger--prt-env-ref'), target: 'workflow',
		edits: [prt, ['\npermissions: {}\n', '\npermissions: {}\nenv:\n  PR_REF: ${{ github.event.pull_request.head.sha }}\n'], withRef('${{ env.PR_REF }}')],
		expect: [[[wf('forbidden-trigger--prt-env-ref'), '[forbidden-trigger]', 'pull_request_target']]],
		why: 'ref: through an env. indirection that holds head.sha',
	},
	{
		id: 'ac31-run-fetch', ac: 'M1-AC31', file: wf('forbidden-trigger--prt-run-fetch'), target: 'workflow',
		edits: [prt, ['      - run: echo "tested"\n', '      - run: git fetch origin "pull/${{ github.event.number }}/head" && git checkout FETCH_HEAD && make\n']],
		expect: [[[wf('forbidden-trigger--prt-run-fetch'), '[forbidden-trigger]', 'pull_request_target']]],
		why: 'a run: step that fetches pull/<n>/head and builds it',
	},
	{
		id: 'ac31-no-checkout', ac: 'M1-AC31', file: wf('forbidden-trigger--prt-no-checkout'), target: 'workflow',
		edits: [
			prt,
			[`${buildCheckout}          persist-credentials: false\n      - uses: ./.github/actions/setup\n`, '      - uses: ./.github/actions/setup\n'],
			[`      - name: Check out\n        uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n          persist-credentials: false\n`, ''],
		],
		expect: [[[wf('forbidden-trigger--prt-no-checkout'), '[forbidden-trigger]', 'pull_request_target']]],
		why: 'banned outright: even a workflow that checks nothing out',
	},
	{
		id: 'ac31-prt-sequence', ac: 'M1-AC31', file: wf('forbidden-trigger--prt-sequence'), target: 'workflow',
		edits: [['on:\n  push:\n    branches: [main]\n  pull_request:\n', 'on: [push, pull_request_target]\n']],
		expect: [[[wf('forbidden-trigger--prt-sequence'), '[forbidden-trigger]', 'pull_request_target']]],
		why: 'the sequence form of on:',
	},
	{
		id: 'ac31-workflow-run-head-sha', ac: 'M1-AC31', file: wf('forbidden-trigger--workflow-run-head-sha'), target: 'workflow',
		edits: [['  pull_request:\n', '  workflow_run:\n    workflows: [ci]\n    types: [completed]\n'], withRef('${{ github.event.workflow_run.head_sha }}')],
		expect: [[[wf('forbidden-trigger--workflow-run-head-sha'), '[forbidden-trigger]', 'workflow_run']]],
		why: 'workflow_run runs with secrets and a write token, and head_sha is the triggering (possibly fork) commit',
	},
	{
		id: 'ac31-workflow-run-scalar', ac: 'M1-AC31', file: wf('forbidden-trigger--workflow-run-scalar'), target: 'workflow',
		edits: [['on:\n  push:\n    branches: [main]\n  pull_request:\n', 'on: workflow_run\n']],
		expect: [[[wf('forbidden-trigger--workflow-run-scalar'), '[forbidden-trigger]', 'workflow_run']]],
		why: 'the scalar form of on:',
	},
	// M1-AC32 (C3): every local `uses: ./<path>` is resolved to <root>/<path>/action.y{a,}ml and checked.
	{
		id: 'ac32-evil', ac: 'M1-AC32', file: wf('local-action--tools-evil'), target: 'workflow',
		edits: [['      - uses: ./.github/actions/setup\n', '      - uses: ./.github/actions/setup\n      - uses: ./tools/evil\n']],
		extra: [{ to: 'tools/evil/action.yml', from: evilAction }],
		expect: [[
			['tools/evil/action.yml', '[sha-pin]', 'actions/setup-node@v4'],
			[wf('local-action--tools-evil'), 'tools/evil'],
		]],
		why: 'NEG: a local action outside .github/actions/ with a tag-pinned step; both files are named',
	},
	{
		id: 'ac32-missing', ac: 'M1-AC32', file: wf('local-action--tools-missing'), target: 'workflow',
		edits: [['      - uses: ./.github/actions/setup\n', '      - uses: ./.github/actions/setup\n      - uses: ./tools/missing\n']],
		expect: [[[wf('local-action--tools-missing'), '[local-action]', 'tools/missing']]],
		why: 'NEG: a local action whose action.yml/action.yaml does not exist',
	},
];

// Positive control for M1-AC32: a valid local action outside .github/actions/, as action.yaml, passes.
export const validLocalActionCase = {
	file: wf('valid-local-action'),
	edits: [['      - uses: ./.github/actions/setup\n', '      - uses: ./.github/actions/setup\n      - uses: ./tools/good\n']] as Edit[],
	extra: [{ to: 'tools/good/action.yaml', from: validActionFixture }] as ExtraFile[],
};

export const hardeningFixture = (c: { file: string }, kind: 'invalid' | 'valid' = 'invalid'): string =>
	join(hardeningFixtures, kind, `${c.file}.fixture`);

// True when, for some alternative, every needle group occurs on one output line.
export const matchesExpectation = (r: RunResult, alternatives: string[][][]): boolean =>
	alternatives.some(groups => groups.every(needles => someLineHasAll(r, needles)));

// A tree like makeWorkflowTree's, plus extra files relative to the tree root.
export const makeTreeWithExtras = (prefix: string, workflows: { name: string; from: string }[], actionFrom: string = validActionFixture, extra: ExtraFile[] = []): WorkflowTree => {
	const tree = makeWorkflowTree(prefix, workflows, actionFrom);
	for (const e of extra) {
		const to = join(tree.root, e.to);
		mkdirSync(join(to, '..'), { recursive: true });
		copyFileSync(e.from, to);
	}
	return tree;
};
