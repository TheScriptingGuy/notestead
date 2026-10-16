// Entry point for `corepack yarn check:workflows [--dir <workflows-dir>]` (M1-AC8, docs/test-plans/M1-S3.md).
// Runs the pinned actionlint (with the pinned shellcheck, pyflakes off) on every workflow file in the directory, then
// the repo's own rules (workflowRules.ts) on those workflows, on the composite actions in ../actions/ and on every local
// action a step uses (`uses: ./<path>`, resolved against the project root, M1-AC32).
// Exit codes: 0 no findings, 1 findings or a failure, 2 usage error. Run by Node's built-in type stripping.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readPinnedTools, resolveTool } from './pinnedTools.ts';
import { analyzeAction, analyzeWorkflow, formatFinding } from './workflowRules.ts';
import type { Finding, LocalUse } from './workflowRules.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const usage = 'usage: corepack yarn check:workflows [--dir <workflows-dir>]  (default: .github/workflows)';

const out = (line: string): void => {
	process.stdout.write(`${line}\n`);
};
const fail = (line: string): void => {
	process.stderr.write(`check:workflows: ${line}\n`);
};

const parseArgs = (argv: string[]): { dir: string } | { help: true } | { error: string } => {
	let dir = join(repoRoot, '.github', 'workflows');
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') return { help: true };
		if (arg === '--dir' && i + 1 < argv.length) {
			dir = argv[++i];
		} else if (arg.startsWith('--dir=')) {
			dir = arg.slice('--dir='.length);
		} else {
			return { error: `unexpected argument "${arg}"` };
		}
	}
	// yarn runs root scripts from the repo root; relative paths are taken from where the command was typed.
	return { dir: resolve(process.env.INIT_CWD ?? process.cwd(), dir) };
};

const isYaml = (name: string): boolean => /\.ya?ml$/.test(name);

const walk = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir).sort().flatMap(entry => {
	const path = join(dir, entry);
	return statSync(path).isDirectory() ? walk(path) : [path];
});

const isInside = (base: string, path: string): boolean => {
	const rel = relative(base, path);
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
};

// File paths in findings are relative to `base` (as actionlint, run from `base`, shows them), else absolute.
const displayFrom = (base: string) => (path: string): string => isInside(base, path) ? relative(base, path) : path;

// The repo rules over the workflows, the composite actions under .github/actions/ and every local action a step uses
// (M1-AC32). A `uses: ./<path>` resolves to <base>/<path>/action.yml or action.yaml, as GitHub resolves it against the
// workspace (the checkout); each action file is checked once, and the actions it uses in turn are followed.
const checkTree = (base: string, workflows: string[], actions: string[], display: (path: string) => string): { findings: Finding[]; actionFiles: number } => {
	const findings: Finding[] = [];
	const pending: LocalUse[] = [];
	const checked = new Map<string, number>();
	const realBase = realpathSync(base);
	const checkActionFile = (path: string): number => {
		const known = checked.get(path);
		if (known !== undefined) return known;
		const r = analyzeAction(display(path), readFileSync(path, 'utf8'));
		checked.set(path, r.findings.length);
		findings.push(...r.findings);
		pending.push(...r.localUses);
		return r.findings.length;
	};
	for (const path of workflows) {
		const r = analyzeWorkflow(display(path), readFileSync(path, 'utf8'));
		findings.push(...r.findings);
		pending.push(...r.localUses);
	}
	for (const path of actions) checkActionFile(resolve(path));
	for (let use = pending.shift(); use; use = pending.shift()) {
		const at = { file: use.file, line: use.line, col: use.col };
		const dir = resolve(base, use.uses);
		const candidates = ['action.yml', 'action.yaml'].map(name => join(dir, name)).filter(path => existsSync(path) && statSync(path).isFile());
		// Inside the project, also after symlinks are followed: a local action is code of this repository.
		const outside = (dir !== base && !isInside(base, dir)) || candidates.some(path => !isInside(realBase, realpathSync(path)));
		if (outside) {
			findings.push({ ...at, message: `${use.where} uses "${use.uses}", which points outside the repository`, rule: 'local-action' });
		} else if (candidates.length === 0) {
			findings.push({ ...at, message: `${use.where} uses "${use.uses}", but neither ${display(join(dir, 'action.yml'))} nor action.yaml exists`, rule: 'local-action' });
		} else {
			const count = checkActionFile(candidates[0]);
			if (count > 0) findings.push({ ...at, message: `${use.where} uses "${use.uses}", and ${display(candidates[0])} has ${count} finding(s)`, rule: 'local-action' });
		}
	}
	return { findings, actionFiles: checked.size };
};

const main = async (argv: string[]): Promise<number> => {
	const args = parseArgs(argv);
	if ('help' in args) {
		out(usage);
		return 0;
	}
	if ('error' in args) {
		fail(`${args.error}\n${usage}`);
		return 2;
	}
	const dir = args.dir;
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		fail(`${dir} does not exist or is not a directory; nothing was checked`);
		return 1;
	}
	const workflows = readdirSync(dir).sort().filter(isYaml).map(name => join(dir, name)).filter(path => statSync(path).isFile());
	if (workflows.length === 0) {
		fail(`no workflow files (*.yml, *.yaml) in ${dir}; refusing to pass without checking anything`);
		return 1;
	}
	const actions = walk(join(dir, '..', 'actions')).filter(path => /(^|[\\/])action\.ya?ml$/.test(path));
	// The project root the workflows belong to: the repo, or the directory holding `.github/` for a tree elsewhere.
	const base = isInside(repoRoot, dir) ? repoRoot : resolve(dir, '..', '..');
	const display = displayFrom(base);

	const tools = readPinnedTools();
	let actionlint: string;
	let shellcheck: string;
	try {
		actionlint = await resolveTool('actionlint', tools.actionlint, out);
		shellcheck = await resolveTool('shellcheck', tools.shellcheck, out);
	} catch (error) {
		fail((error as Error).message);
		return 1;
	}

	// Only the pinned shellcheck, never one from PATH, and no SHELLCHECK_OPTS: the result must not depend on the machine.
	const env = { ...process.env };
	delete env.SHELLCHECK_OPTS;
	const lint = spawnSync(actionlint, ['-no-color', `-shellcheck=${shellcheck}`, '-pyflakes=', ...workflows.map(display)], {
		cwd: base, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
	});
	if (lint.stdout) process.stdout.write(lint.stdout);
	if (lint.stderr) process.stderr.write(lint.stderr);
	if (lint.error || lint.status === null) {
		fail(`actionlint did not run to completion: ${lint.error?.message ?? `signal ${lint.signal}`}`);
		return 1;
	}

	const { findings, actionFiles } = checkTree(base, workflows, actions, display);
	for (const f of findings) out(formatFinding(f));

	const scope = `${workflows.length} workflow file(s) and ${actionFiles} action file(s) (under .github/actions/ or used as ./<path>) in ${dir}`;
	if (lint.status !== 0 || findings.length > 0) {
		fail(`FAILED for ${scope}: actionlint exit ${lint.status}, ${findings.length} finding(s) from the repo rules [sha-pin] [permissions] [forbidden-trigger] [yaml-alias] [workflow-shape] [local-action]`);
		return 1;
	}
	out(`check:workflows: OK, ${scope}: actionlint clean, every uses pinned, every job declares its permissions, no forbidden trigger, no YAML alias, every local action found`);
	return 0;
};

process.exitCode = await main(process.argv.slice(2));
