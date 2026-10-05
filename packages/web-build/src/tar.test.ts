import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberPathProblem, normalizeMemberPath, readTar } from './tar.ts';
import { removeTempDirs, tempDir } from './testing/fixtures.ts';

const longDir = `${'d'.repeat(60)}/${'e'.repeat(60)}`;
const longName = `${longDir}/${'f'.repeat(90)}.js`;

// A tar of a small tree written by GNU tar in the given format (as `package` uses: posix; and the GNU format).
const gnuTar = (format: 'posix' | 'gnu', extra: string[] = []): Buffer => {
	const root = tempDir('tar');
	mkdirSync(join(root, longDir), { recursive: true });
	writeFileSync(join(root, 'index.html'), '<html></html>\n');
	writeFileSync(join(root, longName), 'long\n');
	const result = spawnSync('tar', ['--create', '--file=-', `--format=${format}`, `--directory=${root}`, ...extra, 'index.html', longDir]);
	expect(result.status).toBe(0);
	return result.stdout;
};

const content = (archive: Buffer, member: { offset: number; size: number }): string => archive.subarray(member.offset, member.offset + member.size).toString('utf8');

describe('tar', () => {
	afterAll(removeTempDirs);

	test.each(['posix', 'gnu'] as const)('readTar lists files and directories with their full names (%s format: pax path / GNU long name)', format => {
		const archive = gnuTar(format);
		const members = readTar(archive);
		expect(members.map(m => [normalizeMemberPath(m.name), m.type])).toEqual([
			['index.html', 'file'],
			[longDir, 'directory'],
			[longName, 'file'],
		]);
		expect(content(archive, members[0])).toBe('<html></html>\n');
		expect(content(archive, members[2])).toBe('long\n');
	});

	test('readTar reports links and other types as members of their own type, with the link target', () => {
		const root = tempDir('links');
		writeFileSync(join(root, 'a.txt'), 'a\n');
		spawnSync('ln', ['-s', 'a.txt', join(root, 'sym')]);
		spawnSync('ln', [join(root, 'a.txt'), join(root, 'hard')]);
		spawnSync('mkfifo', [join(root, 'fifo')]);
		const result = spawnSync('tar', ['--create', '--file=-', '--format=posix', `--directory=${root}`, 'a.txt', 'sym', 'hard', 'fifo']);
		expect(result.status).toBe(0);
		expect(readTar(result.stdout).map(m => [m.name, m.type, m.linkName])).toEqual([
			['a.txt', 'file', ''],
			['sym', 'symlink', 'a.txt'],
			['hard', 'hard link', 'a.txt'],
			['fifo', 'FIFO', ''],
		]);
	});

	test('readTar fails on a corrupted header, a truncated archive and a missing end-of-archive block', () => {
		const archive = gnuTar('posix');
		const corrupted = Buffer.from(archive);
		corrupted[0] ^= 0x01;
		expect(() => readTar(corrupted)).toThrow(/checksum mismatch at byte 0/);
		const firstMember = readTar(archive)[0];
		expect(() => readTar(archive.subarray(0, firstMember.offset + 2))).toThrow(/truncated|without an end-of-archive block/);
		expect(() => readTar(archive.subarray(0, firstMember.offset + 512))).toThrow(/without an end-of-archive block/);
	});

	test.each([
		['index.html', null],
		['./icons/a.png', null],
		['icons/', null],
		['', 'has an empty path'],
		['/etc/passwd', 'has an absolute path'],
		['../x', 'has a \'..\' path segment'],
		['a/../../x', 'has a \'..\' path segment'],
		['a//b', 'has an empty or \'.\' path segment'],
		['a/./b', 'has an empty or \'.\' path segment'],
		['a\\b', 'has a backslash in its path'],
	])('memberPathProblem(%j) → %j', (name, problem) => {
		expect(memberPathProblem(name)).toBe(problem);
	});
});
