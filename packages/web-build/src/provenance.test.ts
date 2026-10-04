import { ourRepoUrl, ourSource, publicRepoUrl } from './provenance.ts';
import { removeTempDirs, repoRoot, tempDir } from './testing/fixtures.ts';
import { git } from './upstreamCopy.ts';

describe('provenance', () => {
	afterAll(removeTempDirs);

	test.each([
		['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
		['https://user:secret@github.com/owner/repo.git/', 'https://github.com/owner/repo'],
		['git@github.com:owner/repo.git', 'https://github.com/owner/repo'],
		['ssh://git@github.com:22/owner/repo.git', 'https://github.com/owner/repo'],
		['https://git.example.org:8443/group/sub/repo', 'https://git.example.org:8443/group/sub/repo'],
	])('turns the remote %s into %s without credentials', (remote, expected) => {
		expect(publicRepoUrl(remote)).toBe(expected);
	});

	test.each(['/srv/git/repo.git', 'file:///srv/git/repo.git', 'https://github.com/', ''])('has no public URL for %j', remote => {
		expect(publicRepoUrl(remote)).toBeNull();
	});

	test('prefers NOTESTEAD_SOURCE_REPO, and explains how to fix a repository without a usable remote', () => {
		expect(ourRepoUrl(repoRoot, { NOTESTEAD_SOURCE_REPO: 'https://example.org/ours.git' })).toBe('https://example.org/ours');
		const bare = tempDir('no-remote');
		git(bare, ['init', '--quiet']);
		expect(() => ourRepoUrl(bare, {})).toThrow('has no "origin" remote. Set NOTESTEAD_SOURCE_REPO');
		git(bare, ['remote', 'add', 'origin', '/srv/local/path']);
		expect(() => ourRepoUrl(bare, {})).toThrow('cannot use the "origin" remote');
	});

	test('reads our commit as a full SHA', () => {
		expect(ourSource(repoRoot).commit).toBe(git(repoRoot, ['rev-parse', 'HEAD']).toString().trim());
	});
});
