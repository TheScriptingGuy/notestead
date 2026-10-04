// `build`: the M1-AC5 web bundle build (ADR-0001). Checks out web.repo at exactly web.commit, runs the official
// recipe unmodified (github.com/joplin/web-app deploy-github-pages.yml: `yarn install`, then `yarn web` in
// packages/app-mobile) with SKIP_ONENOTE_CONVERTER_BUILD=1, then applies the overlay, verifies and packages.
// Primary path: x64 CI. On arm64 it runs only with NOTESTEAD_ALLOW_ARM64_WEB_BUILD=1, under the spike S1 conditions
// (docs/spikes/S1/build-web-arm64.sh: ~43 min, ~7 GiB peak, ~13 GB of disk).
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pin } from './pin.ts';
import { git } from './upstreamCopy.ts';

export const arm64Interlock = 'NOTESTEAD_ALLOW_ARM64_WEB_BUILD';

export interface CommandSpec {
	command: string;
	args: string[];
	cwd: string;
	// Variables set on top of the inherited environment (echoed with the command).
	env: Record<string, string>;
}

// Runs a command with inherited stdio and returns its exit code (null when killed by a signal).
export type CommandRunner = (spec: CommandSpec) => number | null;

export interface RecipeOptions {
	arch: string;
	env: NodeJS.ProcessEnv;
}

export const distRelativePath = join('packages', 'app-mobile', 'web', 'dist');

// The recipe's environment overrides: the official recipe plus SKIP_ONENOTE_CONVERTER_BUILD=1 (ADR-0001 §1);
// on arm64 also the S1 conditions (sequential upstream build, a bounded V8 heap).
export const recipeEnv = (options: RecipeOptions): Record<string, string> => {
	const env: Record<string, string> = { SKIP_ONENOTE_CONVERTER_BUILD: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
	if (options.arch === 'arm64') {
		env.BUILD_SEQUENCIAL = '1';
		env.NODE_OPTIONS = options.env.NODE_OPTIONS ?? '--max-old-space-size=3072';
	}
	return env;
};

export const recipe = (work: string, options: RecipeOptions): CommandSpec[] => {
	const env = recipeEnv(options);
	return [
		{ command: 'corepack', args: ['yarn', 'install'], cwd: work, env },
		{ command: 'corepack', args: ['yarn', 'web'], cwd: join(work, 'packages', 'app-mobile'), env },
	];
};

export const describeCommand = (spec: CommandSpec): string =>
	`+ (cd ${spec.cwd} && ${Object.entries(spec.env).map(([k, v]) => `${k}=${v} `).join('')}${spec.command} ${spec.args.join(' ')})`;

// The environment for the upstream recipe: ours without the variables yarn injects into our own workspace script,
// so the upstream checkout's yarn (its own packageManager pin) configures itself from scratch.
export const childEnv = (env: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv => {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (/^(npm_|yarn_|berry_)/i.test(key) || key === 'INIT_CWD' || key === 'PROJECT_CWD') continue;
		result[key] = value;
	}
	return { ...result, ...overrides };
};

const hasHeadAt = (dir: string, commit: string): boolean => {
	try {
		return git(dir, ['rev-parse', 'HEAD']).toString().trim() === commit;
	} catch {
		return false;
	}
};

const hasCommitObject = (dir: string, commit: string): boolean => {
	try {
		git(dir, ['cat-file', '-e', `${commit}^{commit}`]);
		return true;
	} catch {
		return false;
	}
};

// Tracked files of `work` that differ from its HEAD (`git status --porcelain` lines, untracked files excluded).
export const trackedChanges = (work: string): string[] =>
	git(work, ['status', '--porcelain', '--untracked-files=no']).toString().split('\n').filter(line => line.trim() !== '');

// Marks a directory as a work dir created by `build`. Only marked (or new, or empty) directories are ever touched by
// the destructive steps below (checkout --force, clean), so a mistyped --work can never lose anyone's files.
export const workMarker = '.notestead-web-build-work';

// Makes sure `work` may be used: a missing or empty directory is created and marked; a marked one is reused; anything
// else is refused before any change, naming the directory.
export const claimWorkDir = (work: string, repo: string): void => {
	if (existsSync(work)) {
		if (!statSync(work).isDirectory()) throw new Error(`the work directory ${work} is not a directory; nothing was changed`);
		if (existsSync(join(work, workMarker))) return;
		if (readdirSync(work).length > 0) {
			throw new Error(`refusing to use ${work} as the build work directory: it is not empty and was not created by \`build\` (no ${workMarker} marker). Pass a new or empty directory with --work; nothing in ${work} was changed.`);
		}
	}
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, workMarker), `Work directory of \`corepack yarn workspace web-build build\` (Notestead), a checkout of ${repo}.\nbuild resets and cleans this directory on every run; delete it to reclaim the space.\n`);
};

// Ensures `work` is a pristine checkout of `repo` at exactly `commit` (a depth-1 fetch of that commit). The directory
// must be new, empty or marked by an earlier build (claimWorkDir). A marked checkout is reused, but always restored:
// tracked files are reset to the commit and untracked, non-ignored files are removed, so a locally edited upstream
// tree can never be built and labelled as web.commit. Ignored files (the ~11 GB of node_modules and upstream's build
// outputs) are kept on purpose so a rebuild is incremental; the recipe regenerates the build outputs, and nothing
// here detects edits inside ignored files (docs/worklog/M1-S2.md).
export const checkoutPinned = (pin: Pin, work: string, log: (line: string) => void): void => {
	const { repo, commit } = pin.web;
	if (repo.startsWith('-')) throw new Error(`web.repo ${repo} is not a repository URL`);
	claimWorkDir(work, repo);
	const reuse = existsSync(join(work, '.git'));
	const steps: string[][] = [];
	if (!reuse) steps.push(['init', '--quiet']);
	if (reuse && hasCommitObject(work, commit)) {
		log(`build: reusing the checkout of ${commit} in ${work}; restoring its tracked files and removing untracked ones (ignored files such as node_modules are kept)`);
	} else {
		steps.push(['fetch', '--quiet', '--depth', '1', '--no-tags', repo, commit]);
	}
	steps.push(['checkout', '--quiet', '--force', '--detach', commit], ['clean', '--quiet', '--force', '-d', '--exclude', `/${workMarker}`]);
	for (const args of steps) {
		log(`+ (cd ${work} && git ${args.join(' ')})`);
		git(work, args);
	}
	if (!hasHeadAt(work, commit)) throw new Error(`${work} is not at web.commit ${commit} after the checkout`);
	const changed = trackedChanges(work);
	if (changed.length > 0) {
		throw new Error(`${work} still differs from web.commit ${commit} after the checkout; refusing to build a modified upstream tree:\n  ${changed.join('\n  ')}`);
	}
};

export interface BuildOptions {
	pin: Pin;
	work: string;
	runner: CommandRunner;
	log: (line: string) => void;
	arch?: string;
	env?: NodeJS.ProcessEnv;
}

// Checks out and builds the pinned upstream web bundle; returns the path of the built (un-overlaid) dist.
export const buildUpstreamBundle = (options: BuildOptions): string => {
	const arch = options.arch ?? process.arch;
	const env = options.env ?? process.env;
	if (arch === 'arm64' && env[arm64Interlock] !== '1') {
		throw new Error(`refusing to start the native arm64 web build (~43 min, ~7 GiB peak memory, ~13 GB of disk; spike S1). The release path is the x64 CI artifact (ADR-0001). Set ${arm64Interlock}=1 to build on this machine anyway.`);
	}
	checkoutPinned(options.pin, options.work, options.log);
	const dist = join(options.work, distRelativePath);
	// A stale dist from an earlier build must never leak into the artifact.
	rmSync(dist, { recursive: true, force: true });
	for (const spec of recipe(options.work, { arch, env })) {
		options.log(describeCommand(spec));
		const code = options.runner(spec);
		if (code !== 0) throw new Error(`the upstream recipe step \`${spec.command} ${spec.args.join(' ')}\` failed (exit ${code}) in ${spec.cwd}`);
	}
	if (!existsSync(join(dist, 'index.html'))) throw new Error(`the upstream recipe finished but ${dist} has no index.html`);
	// Evidence for the first CI runs: does upstream's own install/build rewrite tracked files (e.g. yarn.lock)?
	const changed = trackedChanges(options.work);
	options.log(changed.length === 0
		? 'build: the upstream recipe left every tracked file unchanged'
		: `build: note: the upstream recipe changed ${changed.length} tracked file(s): ${changed.map(line => line.slice(3)).join(', ')}`);
	return dist;
};
