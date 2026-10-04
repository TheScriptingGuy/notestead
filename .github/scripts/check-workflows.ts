// Entry point for `corepack yarn check:workflows [--dir <workflows-dir>]` (M1-AC8, docs/test-plans/M1-S3.md).
// Runs the pinned actionlint (with the pinned shellcheck, pyflakes off) on every workflow file in the directory, then
// the repo's own rules (workflowRules.ts) on those workflows and on the composite actions in ../actions/.
// Exit codes: 0 no findings, 1 findings or a failure, 2 usage error. Run by Node's built-in type stripping.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readPinnedTools, resolveTool } from './pinnedTools.ts';
import { checkAction, checkWorkflow, formatFinding } from './workflowRules.ts';

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

	const findings = [
		...workflows.flatMap(path => checkWorkflow(display(path), readFileSync(path, 'utf8'))),
		...actions.flatMap(path => checkAction(display(path), readFileSync(path, 'utf8'))),
	];
	for (const f of findings) out(formatFinding(f));

	const scope = `${workflows.length} workflow file(s) and ${actions.length} composite action(s) in ${dir}`;
	if (lint.status !== 0 || findings.length > 0) {
		fail(`FAILED for ${scope}: actionlint exit ${lint.status}, ${findings.length} finding(s) from the repo rules [sha-pin] [permissions] [pull-request-target]`);
		return 1;
	}
	out(`check:workflows: OK, ${scope}: actionlint clean, every uses pinned, every job declares its permissions`);
	return 0;
};

process.exitCode = await main(process.argv.slice(2));
