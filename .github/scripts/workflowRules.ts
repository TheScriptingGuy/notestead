// The repository's own pipeline security rules for `check:workflows` (M1-AC8, docs/test-plans/M1-S3.md; hardened in
// M1-S8, M1-AC30 to M1-AC32, docs/test-plans/M1-S8.md §check:workflows contract), applied on top of actionlint:
// - [sha-pin]: every `uses:` (step or reusable-workflow job, in workflows and composite actions) is a local action,
//   a docker:// image by sha256 digest, or owner/repo[/path]@<full 40-hex commit SHA>.
// - [permissions]: every job declares its own `permissions:` mapping; no write-all/read-all anywhere.
// - [forbidden-trigger]: no `pull_request_target` or `workflow_run` trigger, in any form of `on:` (ADR-0009 A7). Both
//   run with secrets and a write token in the context of code a fork can influence. No allow-list.
// - [yaml-alias]: no YAML alias (`*name`) and no merge key (`<<`) in a workflow or action file. They are rejected, and
//   the other rules still run on the resolved nodes, so an alias can never hide a step or a job from them.
// - [workflow-shape]: a job or a step (workflow or composite action) that is not a mapping, and `jobs:`/`steps:` that
//   are not a mapping/sequence, are reported, never skipped.
// - [local-action]: every step `uses: ./<path>` names a local action whose action.yml/action.yaml exists inside the
//   repository; check-workflows.ts resolves it and checks it with the action rules (the references are returned here).
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml';
import type { Document, Node as YamlNode, YAMLMap } from 'yaml';

export interface Finding {
	file: string;
	line?: number;
	col?: number;
	message: string;
	rule: string;
}

// A step `uses: ./<path>` found in a workflow or an action file; check-workflows.ts resolves and checks it.
export interface LocalUse {
	file: string;
	line?: number;
	col?: number;
	// who uses it, for messages: `job "build" step 2`, or `step 3` in an action file
	where: string;
	// the `uses:` value as written (`./tools/evil`)
	uses: string;
}

export interface Analysis {
	findings: Finding[];
	localUses: LocalUse[];
}

// actionlint's format: `<file>:<line>:<col>: <message> [<rule>]`.
export const formatFinding = (f: Finding): string =>
	`${f.file}${f.line ? `:${f.line}:${f.col ?? 1}` : ''}: ${f.message} [${f.rule}]`;

export const isPinnedUses = (value: string): boolean =>
	value.startsWith('./')
	|| /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(value)
	|| /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/.test(value);

const pinAdvice = 'pin it to a full 40-character commit SHA (owner/repo@<sha> # vX.Y.Z), a docker:// image by @sha256 digest, or use a local ./ action';

// Triggers that run with the base repository's secrets and a write token on behalf of code or data a fork controls.
export const forbiddenTriggers = ['pull_request_target', 'workflow_run'] as const;

const broadPermissions = new Set(['write-all', 'read-all']);

type Located = (node: YamlNode | null | undefined, message: string, rule: string) => void;

interface Parsed {
	root: YAMLMap;
	report: Located;
	// Resolves an alias to the node it names (the anchored node); any other node is returned as is.
	deref: (node: unknown) => YamlNode | null | undefined;
	pos: (node: YamlNode | null | undefined) => { line?: number; col?: number };
}

const scalarText = (node: unknown): string | null =>
	isScalar(node) && node.value !== null && node.value !== undefined ? String(node.value) : null;

const keyText = (key: unknown): string => String(isScalar(key) ? key.value : key);

const parse = (file: string, text: string, findings: Finding[]): Parsed | null => {
	const lineCounter = new LineCounter();
	const doc: Document = parseDocument(text, { lineCounter });
	const pos = (node: YamlNode | null | undefined): { line?: number; col?: number } => {
		const offset = node?.range?.[0];
		const p = offset === undefined ? undefined : lineCounter.linePos(offset);
		return { line: p?.line, col: p?.col };
	};
	const report: Located = (node, message, rule) => {
		findings.push({ file, ...pos(node), message, rule });
	};
	if (doc.errors.length > 0) {
		findings.push({ file, message: `cannot be parsed as YAML: ${doc.errors[0].message.split('\n')[0]}`, rule: 'yaml-syntax' });
		return null;
	}
	// M1-AC30: aliases and merge keys are rejected wherever they occur (keys, values, sequence items).
	visit(doc, {
		Alias: (_, node) => {
			report(node, `uses the YAML alias *${node.source}; aliases can hide jobs and steps from review and from these rules, so write the content out`, 'yaml-alias');
		},
		Pair: (_, pair) => {
			if (isScalar(pair.key) && pair.key.value === '<<') {
				report(pair.key, 'uses a YAML merge key (<<); merged content can hide jobs and steps from review and from these rules, so write it out', 'yaml-alias');
			}
		},
	});
	const deref = (node: unknown): YamlNode | null | undefined => {
		// An alias to an alias is not possible in YAML (an anchor names a node, not an alias), but loop defensively.
		let current = node as YamlNode | null | undefined;
		for (let i = 0; i < 8 && isAlias(current); i++) current = current.resolve(doc) as YamlNode | undefined;
		return isAlias(current) ? undefined : current;
	};
	const contents = deref(doc.contents);
	if (!isMap(contents)) {
		findings.push({ file, message: 'is not a YAML mapping', rule: 'yaml-syntax' });
		return null;
	}
	return { root: contents, report, deref, pos };
};

const field = (p: Parsed, map: YAMLMap, key: string): YamlNode | null | undefined => p.deref(map.get(key, true));

const mapEntries = (p: Parsed, node: unknown): [string, YamlNode | null | undefined, YamlNode | null][] =>
	isMap(node) ? node.items.map(pair => [keyText(pair.key), p.deref(pair.value), (isScalar(pair.key) ? pair.key : null)]) : [];

const checkUses = (node: YamlNode | null | undefined, where: string, report: Located): void => {
	if (node === undefined) return;
	const value = scalarText(node) ?? '';
	if (!isPinnedUses(value)) report(node, `${where} uses "${value}", which is not pinned: ${pinAdvice}`, 'sha-pin');
};

// The steps of a job or a composite action: [workflow-shape] for anything that is not a sequence of mappings; the
// mapping steps are returned with their 1-based position.
const stepsOf = (p: Parsed, steps: YamlNode | null | undefined, where: string, required: boolean): { step: YAMLMap; n: number }[] => {
	if (steps === undefined || steps === null) {
		if (required && steps === null) p.report(steps, `${where} has an empty steps:`, 'workflow-shape');
		return [];
	}
	if (!isSeq(steps)) {
		p.report(steps, `${where} steps: is not a sequence`, 'workflow-shape');
		return [];
	}
	const out: { step: YAMLMap; n: number }[] = [];
	steps.items.forEach((item, index) => {
		const step = p.deref(item);
		if (isMap(step)) out.push({ step, n: index + 1 });
		else p.report((item ?? undefined) as YamlNode | undefined, `${where} step ${index + 1} is not a mapping (found ${JSON.stringify(scalarText(step) ?? (step === null ? null : typeof step))}); every step must be a mapping with run: or uses:`, 'workflow-shape');
	});
	return out;
};

const collectLocalUse = (p: Parsed, file: string, uses: YamlNode | null | undefined, where: string, out: LocalUse[]): void => {
	const value = scalarText(uses);
	if (value !== null && value.startsWith('./')) out.push({ file, ...p.pos(uses), where, uses: value });
};

const triggerNodes = (p: Parsed, on: YamlNode | null | undefined): { name: string; node: YamlNode | null | undefined }[] => {
	if (isScalar(on)) return [{ name: String(on.value), node: on }];
	if (isSeq(on)) return on.items.map(item => p.deref(item)).map(node => ({ name: scalarText(node) ?? '', node }));
	if (isMap(on)) return on.items.map(pair => ({ name: keyText(pair.key), node: (isScalar(pair.key) ? pair.key : p.deref(pair.value)) }));
	return [];
};

// Checks one workflow file. `file` is the path shown in findings.
export const analyzeWorkflow = (file: string, text: string): Analysis => {
	const findings: Finding[] = [];
	const localUses: LocalUse[] = [];
	const p = parse(file, text, findings);
	if (!p) return { findings, localUses };
	const { root, report } = p;

	const workflowPermissions = field(p, root, 'permissions');
	const workflowScope = scalarText(workflowPermissions);
	if (workflowScope !== null && broadPermissions.has(workflowScope)) {
		report(workflowPermissions, `the workflow sets permissions: ${workflowScope}; grant no workflow-level scope (permissions: {}) and name the scopes each job needs`, 'permissions');
	}

	for (const { name, node } of triggerNodes(p, field(p, root, 'on'))) {
		if ((forbiddenTriggers as readonly string[]).includes(name)) {
			report(node, `the workflow is triggered by ${name}, which runs with the repository's secrets and a write token for events a fork controls; it is not allowed (ADR-0009 A7)`, 'forbidden-trigger');
		}
	}

	const jobs = field(p, root, 'jobs');
	if (jobs !== undefined && !isMap(jobs)) report(jobs, 'jobs: is not a mapping of job ids to jobs', 'workflow-shape');

	for (const [jobId, job, keyNode] of mapEntries(p, jobs)) {
		if (!isMap(job)) {
			report(job ?? keyNode, `job "${jobId}" is not a mapping (found ${JSON.stringify(scalarText(job) ?? (job === null || job === undefined ? null : typeof job))}); a job must be a mapping with runs-on/steps or uses`, 'workflow-shape');
			continue;
		}
		const permissions = field(p, job, 'permissions');
		if (!job.has('permissions')) {
			report(job, `job "${jobId}" declares no permissions: of its own; name only the scopes it needs (permissions: {} for none)`, 'permissions');
		} else if (!isMap(permissions)) {
			const value = scalarText(permissions) ?? '';
			report(permissions, broadPermissions.has(value)
				? `job "${jobId}" uses permissions: ${value}; name only the scopes it needs`
				: `job "${jobId}" permissions: must be a mapping of scopes, found "${value}"`, 'permissions');
		}

		checkUses(field(p, job, 'uses'), `job "${jobId}"`, report);

		for (const { step, n } of stepsOf(p, field(p, job, 'steps'), `job "${jobId}"`, true)) {
			const uses = field(p, step, 'uses');
			checkUses(uses, `job "${jobId}" step ${n}`, report);
			collectLocalUse(p, file, uses, `job "${jobId}" step ${n}`, localUses);
		}
	}
	return { findings, localUses };
};

// Checks one composite (or docker) action metadata file: the pin rule, the shape of its steps and its local actions.
export const analyzeAction = (file: string, text: string): Analysis => {
	const findings: Finding[] = [];
	const localUses: LocalUse[] = [];
	const p = parse(file, text, findings);
	if (!p) return { findings, localUses };
	const { root, report } = p;
	const runs = field(p, root, 'runs');
	if (!isMap(runs)) return { findings, localUses };
	for (const { step, n } of stepsOf(p, field(p, runs, 'steps'), 'composite action', false)) {
		const uses = field(p, step, 'uses');
		checkUses(uses, `step ${n}`, report);
		collectLocalUse(p, file, uses, `step ${n}`, localUses);
	}
	const image = field(p, runs, 'image');
	const imageText = scalarText(image);
	if (imageText?.startsWith('docker://')) checkUses(image, 'runs.image', report);
	return { findings, localUses };
};

export const checkWorkflow = (file: string, text: string): Finding[] => analyzeWorkflow(file, text).findings;
export const checkAction = (file: string, text: string): Finding[] => analyzeAction(file, text).findings;
