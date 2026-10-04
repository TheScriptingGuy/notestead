// Detects verbatim copies of upstream Joplin files (ADR-0009 `check:no-upstream-copy`, M1-AC4; golden rule
// "reuse, never fork"). A tracked file of at least 1 KiB fails the check when its git blob ID equals the blob ID of
// any file in the upstream tree at the pinned commit. Only blob IDs are compared, so the upstream tree is needed
// without file contents: a blobless, depth-1 fetch of the pinned commit is enough.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const minimumSize = 1024;

export interface Copy {
	// Path relative to the scanned root, with forward slashes (as git prints it).
	path: string;
	upstreamPaths: string[];
}

export interface ScanResult {
	scanned: number;
	copies: Copy[];
}

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

// Runs git and returns its stdout. Throws with git's stderr on failure.
export const git = (cwd: string, args: string[]): Buffer => {
	const result = spawnSync('git', args, { cwd, env: gitEnv(), maxBuffer: 256 * 1024 * 1024 });
	if (result.error) throw new Error(`git ${args.join(' ')} could not run in ${cwd}: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed in ${cwd} (exit ${result.status}): ${result.stderr.toString().trim()}`);
	}
	return result.stdout;
};

// The ID git gives a blob with this content (SHA-1 object format, as used by upstream).
export const gitBlobId = (content: Buffer): string =>
	createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

const splitNul = (output: Buffer): string[] => output.toString('utf8').split('\0').filter(entry => entry !== '');

// Maps each blob ID in the tree of `commit` to the upstream paths that hold it.
export const upstreamBlobIndex = (gitDir: string, commit: string): Map<string, string[]> => {
	const index = new Map<string, string[]>();
	for (const entry of splitNul(git(gitDir, ['ls-tree', '-r', '-z', '--full-tree', commit]))) {
		// "<mode> <type> <object>\t<path>"
		const tab = entry.indexOf('\t');
		const [, type, objectId] = entry.slice(0, tab).split(' ');
		if (type !== 'blob') continue;
		const paths = index.get(objectId) ?? [];
		paths.push(entry.slice(tab + 1));
		index.set(objectId, paths);
	}
	return index;
};

// The git-tracked paths of `root` (POSIX, relative to it). Untracked and ignored files are never listed.
export const trackedFiles = (root: string): string[] => splitNul(git(root, ['ls-files', '-z']));

// Scans the git-tracked regular files of `root` (untracked and ignored files are never read).
export const findCopies = (root: string, index: Map<string, string[]>): ScanResult => {
	const copies: Copy[] = [];
	let scanned = 0;
	for (const path of trackedFiles(root)) {
		const absolute = join(root, path);
		let stats;
		try {
			stats = lstatSync(absolute);
		} catch {
			continue; // tracked but deleted in the working tree
		}
		if (!stats.isFile() || stats.size < minimumSize) continue;
		scanned++;
		const upstreamPaths = index.get(gitBlobId(readFileSync(absolute)));
		if (upstreamPaths) copies.push({ path, upstreamPaths });
	}
	return { scanned, copies };
};

const hasCommit = (gitDir: string, commit: string): boolean =>
	spawnSync('git', ['cat-file', '-e', `${commit}^{tree}`], { cwd: gitDir, env: gitEnv() }).status === 0;

export const defaultCacheDir = (): string =>
	process.env.NOTESTEAD_CACHE_DIR
		?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'notestead');

export interface UpstreamTree {
	gitDir: string;
	fetched: boolean;
}

// Returns a git directory that contains the tree of `commit`: `upstreamDir` when given (it must contain the commit),
// otherwise a cached blobless clone of `repo` at `commit`, fetched on first use.
export const ensureUpstreamTree = (repo: string, commit: string, upstreamDir: string | null, cacheDir: string): UpstreamTree => {
	if (upstreamDir !== null) {
		if (!existsSync(upstreamDir)) throw new Error(`--upstream ${upstreamDir} does not exist`);
		if (!hasCommit(upstreamDir, commit)) throw new Error(`--upstream ${upstreamDir} does not contain web.commit ${commit}`);
		return { gitDir: upstreamDir, fetched: false };
	}

	const target = join(cacheDir, 'upstream', `${commit}.git`);
	if (existsSync(target) && hasCommit(target, commit)) return { gitDir: target, fetched: false };
	if (repo.startsWith('-')) throw new Error(`web.repo ${repo} is not a repository URL`);

	mkdirSync(join(cacheDir, 'upstream'), { recursive: true });
	const temporary = `${target}.tmp-${process.pid}`;
	rmSync(temporary, { recursive: true, force: true });
	try {
		git(cacheDir, ['init', '--quiet', '--bare', temporary]);
		git(temporary, ['remote', 'add', 'origin', repo]);
		git(temporary, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', commit]);
		if (!hasCommit(temporary, commit)) throw new Error(`fetching ${commit} from ${repo} did not produce its tree`);
		rmSync(target, { recursive: true, force: true });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
	return { gitDir: target, fetched: true };
};
