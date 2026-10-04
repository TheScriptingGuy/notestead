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
	// File name under tests/fixtures/m1-s3/workflows/invalid/ (without the `.fixture` suffix). Prefix = expected rule.
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
		needles: [wf('pull-request-target--head-sha-checkout'), '[pull-request-target]'],
		why: 'pull_request_target runs with secrets; checking out the PR head runs untrusted code with them',
	},
	{
		file: wf('pull-request-target--head-ref-checkout'), target: 'workflow',
		edits: [
			['  pull_request:\n', '  pull_request_target:\n'],
			[`      - uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n`, `      - uses: actions/checkout@${checkoutSha} # v4.2.2\n        with:\n          ref: \${{ github.head_ref }}\n`],
		],
		needles: [wf('pull-request-target--head-ref-checkout'), '[pull-request-target]'],
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
