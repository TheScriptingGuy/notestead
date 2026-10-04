// Read-only access to the upstream Joplin tree at the pinned web.commit, used to *generate* fixtures at test time.
// Upstream files are never committed to this repo (CLAUDE.md "reuse, never fork"; docs/testing/strategy.md §4).
//
// Source, in order: JOPLIN_UPSTREAM_DIR, then ~/joplin-web-app-work/upstream-joplin (if it contains web.commit),
// then a blobless depth-1 fetch of web.repo at web.commit cached under test-results/.cache/ (blobs are fetched
// lazily, so only the files a test reads are downloaded). Erasable TypeScript only (Node type stripping).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPin, repoRoot, upstreamCloneDir } from './repo.mts';

export const upstreamPublicDir = 'packages/app-mobile/web/public';

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

const gitBuffer = (cwd: string, args: string[]): Buffer => {
	const r = spawnSync('git', args, { cwd, env: gitEnv(), maxBuffer: 256 * 1024 * 1024 });
	assert.ok(!r.error, `git ${args.join(' ')} could not run in ${cwd}: ${r.error?.message}`);
	assert.equal(r.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr?.toString().trim()}`);
	return r.stdout;
};

const hasCommit = (dir: string, commit: string): boolean =>
	spawnSync('git', ['cat-file', '-e', `${commit}^{tree}`], { cwd: dir, env: gitEnv() }).status === 0;

let gitDirMemo: string | null = null;

// A git directory that contains the tree of the pinned web.commit.
export const upstreamGitDir = (): string => {
	if (gitDirMemo) return gitDirMemo;
	const { web } = readPin();
	assert.match(web.commit, /^[0-9a-f]{40}$/, 'pin web.commit must be a full SHA to derive upstream fixtures');

	const clone = upstreamCloneDir();
	if (clone && hasCommit(clone, web.commit)) {
		gitDirMemo = clone;
		return clone;
	}

	const target = join(repoRoot, 'test-results', '.cache', 'upstream', `${web.commit}.git`);
	if (!(existsSync(target) && hasCommit(target, web.commit))) {
		assert.ok(!web.repo.startsWith('-'), `web.repo ${web.repo} is not a repository URL`);
		mkdirSync(dirname(target), { recursive: true });
		const temporary = `${target}.tmp-${process.pid}`;
		rmSync(temporary, { recursive: true, force: true });
		try {
			gitBuffer(dirname(target), ['init', '--quiet', '--bare', temporary]);
			gitBuffer(temporary, ['remote', 'add', 'origin', web.repo]);
			gitBuffer(temporary, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', web.commit]);
			assert.ok(hasCommit(temporary, web.commit), `fetching ${web.commit} from ${web.repo} did not produce its tree`);
			rmSync(target, { recursive: true, force: true });
			renameSync(temporary, target);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
	gitDirMemo = target;
	return target;
};

// Every file under `prefix` (an upstream directory path) at web.commit, keyed by its path relative to `prefix`.
export const upstreamFilesUnder = (prefix: string): Map<string, Buffer> => {
	const { web } = readPin();
	const dir = upstreamGitDir();
	const files = new Map<string, Buffer>();
	const listing = gitBuffer(dir, ['ls-tree', '-r', '-z', '--full-tree', web.commit, '--', prefix]).toString('utf8');
	for (const entry of listing.split('\0').filter(e => e !== '')) {
		const tab = entry.indexOf('\t');
		const [, type, objectId] = entry.slice(0, tab).split(' ');
		if (type !== 'blob') continue;
		const path = entry.slice(tab + 1);
		files.set(path.slice(prefix.length + 1), gitBuffer(dir, ['cat-file', 'blob', objectId]));
	}
	assert.ok(files.size > 0, `upstream ${prefix} at ${web.commit} has no files: the fixture source is broken`);
	return files;
};

let publicMemo: Map<string, Buffer> | null = null;

// upstream:packages/app-mobile/web/public/** at web.commit (what `yarn web` copies into dist/ after webpack).
export const upstreamPublicFiles = (): Map<string, Buffer> => {
	publicMemo ??= upstreamFilesUnder(upstreamPublicDir);
	return publicMemo;
};

// upstream:packages/app-mobile/web/public/icons/* at web.commit, keyed by `icons/<name>` (M1-AC7's hash list).
export const upstreamIcons = (): Map<string, Buffer> => {
	const icons = new Map<string, Buffer>();
	for (const [path, content] of upstreamPublicFiles()) if (path.startsWith('icons/')) icons.set(path, content);
	return icons;
};

export const sha256 = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex');

export const upstreamIconHashes = (): Map<string, string> => {
	const hashes = new Map<string, string>();
	for (const [path, content] of upstreamIcons()) hashes.set(sha256(content), path);
	return hashes;
};
