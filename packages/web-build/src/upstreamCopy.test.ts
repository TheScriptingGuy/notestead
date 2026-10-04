// Runs against real git repositories built in temp directories (no network): a local "upstream" repository serves
// the blobless fetch through the file:// transport, as GitHub does for the pinned commit.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureUpstreamTree, findCopies, git, gitBlobId, upstreamBlobIndex } from './upstreamCopy.ts';

const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const big = (label: string): string => `// ${label}\n`.repeat(200); // well over 1 KiB
const temps: string[] = [];

const tempDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
	temps.push(dir);
	return dir;
};

const write = (root: string, path: string, content: string): void => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
};

// A repository with the given files committed; returns its directory and the commit ID.
const upstreamRepo = (files: Record<string, string>): { dir: string; commit: string } => {
	const dir = tempDir('upstream');
	git(dir, ['init', '--quiet']);
	for (const [path, content] of Object.entries(files)) write(dir, path, content);
	git(dir, ['add', '--all']);
	git(dir, [...identity, 'commit', '--quiet', '-m', 'upstream']);
	git(dir, ['config', 'uploadpack.allowFilter', 'true']);
	git(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
	return { dir, commit: git(dir, ['rev-parse', 'HEAD']).toString().trim() };
};

describe('upstreamCopy', () => {
	afterAll(() => {
		for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	});

	test('computes the same blob ID as git hash-object', () => {
		const dir = tempDir('blob');
		write(dir, 'file.txt', big('blob'));
		expect(gitBlobId(Buffer.from(big('blob')))).toBe(git(dir, ['hash-object', 'file.txt']).toString().trim());
	});

	test('flags tracked copies of at least 1 KiB, under any name, and nothing else', () => {
		const upstream = upstreamRepo({ 'web/serviceWorker.ts': big('upstream'), 'small.txt': 'tiny', 'link-target.ts': big('linked') });
		const index = upstreamBlobIndex(upstream.dir, upstream.commit);

		const root = tempDir('ours');
		git(root, ['init', '--quiet']);
		write(root, 'lib/sw-copy.ts', big('upstream')); // renamed verbatim copy
		write(root, 'lib/own.ts', big('ours'));
		write(root, 'small-copy.txt', 'tiny'); // identical but below 1 KiB
		write(root, '.gitignore', 'node_modules/\n');
		symlinkSync(join(upstream.dir, 'link-target.ts'), join(root, 'link.ts')); // tracked symlink, not a file
		git(root, ['add', '--all']);
		write(root, 'node_modules/pkg/serviceWorker.ts', big('upstream')); // ignored
		write(root, 'untracked.ts', big('upstream')); // untracked

		const { scanned, copies } = findCopies(root, index);
		expect(copies).toEqual([{ path: 'lib/sw-copy.ts', upstreamPaths: ['web/serviceWorker.ts'] }]);
		expect(scanned).toBe(2);
	});

	test('fetches the pinned tree without blobs into the cache once, then reuses it', () => {
		const upstream = upstreamRepo({ 'a.ts': big('a') });
		const cache = tempDir('cache');
		const url = `file://${upstream.dir}`;

		const first = ensureUpstreamTree(url, upstream.commit, null, cache);
		expect(first).toEqual({ gitDir: join(cache, 'upstream', `${upstream.commit}.git`), fetched: true });
		expect([...upstreamBlobIndex(first.gitDir, upstream.commit).keys()]).toEqual([gitBlobId(Buffer.from(big('a')))]);
		expect(ensureUpstreamTree(url, upstream.commit, null, cache).fetched).toBe(false);
	});

	test('uses --upstream as given, and rejects one that lacks the pinned commit', () => {
		const upstream = upstreamRepo({ 'a.ts': big('a') });
		expect(ensureUpstreamTree('unused', upstream.commit, upstream.dir, tempDir('cache'))).toEqual({ gitDir: upstream.dir, fetched: false });
		const missing = '0123456789abcdef0123456789abcdef01234567';
		expect(() => ensureUpstreamTree('unused', missing, upstream.dir, tempDir('cache'))).toThrow(`does not contain web.commit ${missing}`);
	});
});
