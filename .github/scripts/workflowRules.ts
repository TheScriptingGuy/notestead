// The repository's own pipeline security rules for `check:workflows` (M1-AC8, docs/test-plans/M1-S3.md), applied on
// top of actionlint:
// - [sha-pin]: every `uses:` (step or reusable-workflow job, in workflows and composite actions) is a local action,
//   a docker:// image by sha256 digest, or owner/repo[/path]@<full 40-hex commit SHA>.
// - [permissions]: every job declares its own `permissions:` mapping; no write-all/read-all anywhere.
// - [pull-request-target]: a pull_request_target workflow never checks out pull request code.
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { Node as YamlNode, YAMLMap } from 'yaml';

export interface Finding {
	file: string;
	line?: number;
	col?: number;
	message: string;
	rule: string;
}

// actionlint's format: `<file>:<line>:<col>: <message> [<rule>]`.
export const formatFinding = (f: Finding): string =>
	`${f.file}${f.line ? `:${f.line}:${f.col ?? 1}` : ''}: ${f.message} [${f.rule}]`;

export const isPinnedUses = (value: string): boolean =>
	value.startsWith('./')
	|| /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(value)
	|| /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/.test(value);

const pinAdvice = 'pin it to a full 40-character commit SHA (owner/repo@<sha> # vX.Y.Z), a docker:// image by @sha256 digest, or use a local ./ action';

// Refs that point at code the pull request author controls.
const prHeadPatterns = ['github.event.pull_request.head', 'github.head_ref', 'refs/pull/'];

const broadPermissions = new Set(['write-all', 'read-all']);

type Located = (node: YamlNode | null | undefined, message: string, rule: string) => void;

const scalarText = (node: unknown): string | null =>
	isScalar(node) && node.value !== null && node.value !== undefined ? String(node.value) : null;

const mapEntries = (node: unknown): [string, YamlNode | null][] =>
	isMap(node) ? node.items.map(pair => [String(isScalar(pair.key) ? pair.key.value : pair.key), pair.value as YamlNode | null]) : [];

const field = (map: YAMLMap, key: string): YamlNode | null | undefined => map.get(key, true) as YamlNode | null | undefined;

const checkUses = (node: YamlNode | null | undefined, where: string, report: Located): void => {
	if (node === undefined) return;
	const value = scalarText(node) ?? '';
	if (!isPinnedUses(value)) report(node, `${where} uses "${value}", which is not pinned: ${pinAdvice}`, 'sha-pin');
};

const triggers = (on: unknown): string[] => {
	if (isScalar(on)) return [String(on.value)];
	if (isSeq(on)) return on.items.map(item => scalarText(item) ?? '');
	return mapEntries(on).map(([key]) => key);
};

const parse = (file: string, text: string, findings: Finding[]): { root: YAMLMap; report: Located } | null => {
	const lineCounter = new LineCounter();
	const doc = parseDocument(text, { lineCounter });
	const report: Located = (node, message, rule) => {
		const offset = node?.range?.[0];
		const pos = offset === undefined ? undefined : lineCounter.linePos(offset);
		findings.push({ file, line: pos?.line, col: pos?.col, message, rule });
	};
	if (doc.errors.length > 0) {
		findings.push({ file, message: `cannot be parsed as YAML: ${doc.errors[0].message.split('\n')[0]}`, rule: 'yaml-syntax' });
		return null;
	}
	if (!isMap(doc.contents)) {
		findings.push({ file, message: 'is not a YAML mapping', rule: 'yaml-syntax' });
		return null;
	}
	return { root: doc.contents, report };
};

// Checks one workflow file. `file` is the path shown in findings.
export const checkWorkflow = (file: string, text: string): Finding[] => {
	const findings: Finding[] = [];
	const parsed = parse(file, text, findings);
	if (!parsed) return findings;
	const { root, report } = parsed;

	const workflowPermissions = field(root, 'permissions');
	const workflowScope = scalarText(workflowPermissions);
	if (workflowScope !== null && broadPermissions.has(workflowScope)) {
		report(workflowPermissions, `the workflow sets permissions: ${workflowScope}; grant no workflow-level scope (permissions: {}) and name the scopes each job needs`, 'permissions');
	}

	const prTarget = triggers(field(root, 'on')).includes('pull_request_target');

	for (const [jobId, job] of mapEntries(field(root, 'jobs'))) {
		if (!isMap(job)) continue; // actionlint reports malformed jobs
		const permissions = field(job, 'permissions');
		if (!job.has('permissions')) {
			report(job, `job "${jobId}" declares no permissions: of its own; name only the scopes it needs (permissions: {} for none)`, 'permissions');
		} else if (!isMap(permissions)) {
			const value = scalarText(permissions) ?? '';
			report(permissions, broadPermissions.has(value)
				? `job "${jobId}" uses permissions: ${value}; name only the scopes it needs`
				: `job "${jobId}" permissions: must be a mapping of scopes, found "${value}"`, 'permissions');
		}

		checkUses(field(job, 'uses'), `job "${jobId}"`, report);

		const steps = field(job, 'steps');
		if (!isSeq(steps)) continue;
		steps.items.forEach((step, index) => {
			if (!isMap(step)) return;
			const uses = field(step, 'uses');
			checkUses(uses, `job "${jobId}" step ${index + 1}`, report);
			const action = (scalarText(uses) ?? '').split('@')[0];
			if (!prTarget || action !== 'actions/checkout') return;
			const inputs = field(step, 'with');
			for (const input of ['ref', 'repository']) {
				const node = isMap(inputs) ? field(inputs, input) : undefined;
				const value = scalarText(node);
				if (value !== null && prHeadPatterns.some(p => value.includes(p))) {
					report(node, `job "${jobId}" step ${index + 1} checks out pull request code (${input}: ${value}) in a pull_request_target workflow, which runs with secrets and a write token`, 'pull-request-target');
				}
			}
		});
	}
	return findings;
};

// Checks one composite (or docker) action metadata file: only the pin rule applies.
export const checkAction = (file: string, text: string): Finding[] => {
	const findings: Finding[] = [];
	const parsed = parse(file, text, findings);
	if (!parsed) return findings;
	const { root, report } = parsed;
	const runs = field(root, 'runs');
	if (!isMap(runs)) return findings;
	const steps = field(runs, 'steps');
	if (isSeq(steps)) {
		steps.items.forEach((step, index) => {
			if (isMap(step)) checkUses(field(step, 'uses'), `step ${index + 1}`, report);
		});
	}
	const image = field(runs, 'image');
	const imageText = scalarText(image);
	if (imageText?.startsWith('docker://')) checkUses(image, 'runs.image', report);
	return findings;
};
