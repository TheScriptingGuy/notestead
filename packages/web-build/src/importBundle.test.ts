// The checks of `import` that the acceptance suite (tests/acceptance/m1-s4) reaches only through the manifest: tar
// members that are unsafe while the manifest is consistent, the staging dir's cleanup and the installed modes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { importBundle, manifestName, sumsName } from './importBundle.ts';
import type { ImportOptions } from './importBundle.ts';
import { artifactName, packageBundle } from './packageBundle.ts';
import { distFixture, pinFor, removeTempDirs, tempDir } from './testing/fixtures.ts';
import { hashFiles, sha256 } from './tree.ts';
import type { BundleFile } from './tree.ts';

const pin = pinFor('https://example.org/upstream.git', 'a'.repeat(40), 'v1.2.3');
const ours = { commit: 'b'.repeat(40), dirty: false };

const options = (artifactDir: string, out: string, verify: (dist: string) => void = () => {}): ImportOptions => ({ artifactDir, out, pin, pinLabel: 'pin.json', verify });

// An artifact around `tar` (uncompressed bytes) whose manifest lists `files` and whose SHA256SUMS matches both.
const artifactAround = (tar: Buffer, files: BundleFile[]): string => {
	const dir = tempDir('artifact');
	writeFileSync(join(dir, artifactName(pin)), zstdCompressSync(tar));
	writeFileSync(join(dir, manifestName), `${JSON.stringify({ upstream: { repo: pin.web.repo, tag: pin.web.tag, commit: pin.web.commit }, notestead: ours, files }, null, '\t')}\n`);
	const sums = [artifactName(pin), manifestName].sort().map(name => `${sha256(readFileSync(join(dir, name)))}  ${name}\n`).join('');
	writeFileSync(join(dir, sumsName), sums);
	return dir;
};

const tarOf = (root: string, names: string[], extra: string[] = []): Buffer => {
	const result = spawnSync('tar', ['--create', '--file=-', '--format=posix', `--directory=${root}`, ...extra, ...names], { maxBuffer: 64 * 1024 * 1024 });
	expect(result.status).toBe(0);
	return result.stdout;
};

const outPath = (): string => join(tempDir('out'), 'dist');

const leftovers = (out: string): string[] => readdirSync(dirname(out));

describe('importBundle', () => {
	afterAll(removeTempDirs);

	test('installs a packaged bundle into an existing empty --out with modes 0644/0755 and leaves no staging dir', async () => {
		const dist = distFixture();
		const artifact = tempDir('packaged');
		await packageBundle(dist, artifact, pin, ours);
		const out = outPath();
		mkdirSync(out, { mode: 0o700 });
		const verified: string[] = [];
		const result = importBundle(options(artifact, out, d => verified.push(d)));
		expect(hashFiles(out)).toEqual(hashFiles(dist));
		expect(result.files).toBe(hashFiles(dist).length);
		expect(verified).toHaveLength(1);
		expect(statSync(out).mode & 0o777).toBe(0o755);
		expect(statSync(join(out, 'icons')).mode & 0o777).toBe(0o755);
		expect(statSync(join(out, 'index.html')).mode & 0o777).toBe(0o644);
		expect(leftovers(out)).toEqual(['dist']);
	});

	test('refuses a `..` member before extracting, even when the manifest itself is clean', () => {
		const root = tempDir('dotdot');
		writeFileSync(join(root, 'index.html'), 'x\n');
		const tar = tarOf(root, ['index.html'], ['--absolute-names', '--transform=s,^,../,']);
		const artifact = artifactAround(tar, [{ path: 'index.html', sha256: sha256('x\n'), size: 2 }]);
		const out = outPath();
		expect(() => importBundle(options(artifact, out))).toThrow(/tar member \.\.\/index\.html has a '\.\.' path segment/);
		expect(existsSync(out)).toBe(false);
		expect(leftovers(out)).toEqual([]);
	});

	test('refuses hard links and FIFOs, naming each', () => {
		const root = tempDir('links');
		writeFileSync(join(root, 'index.html'), 'x\n');
		spawnSync('ln', [join(root, 'index.html'), join(root, 'copy.html')]);
		spawnSync('mkfifo', [join(root, 'pipe')]);
		const listed = [{ path: 'copy.html', sha256: sha256('x\n'), size: 2 }, { path: 'index.html', sha256: sha256('x\n'), size: 2 }, { path: 'pipe', sha256: sha256(''), size: 0 }];
		const artifact = artifactAround(tarOf(root, ['index.html', 'copy.html', 'pipe']), listed);
		const out = outPath();
		expect(() => importBundle(options(artifact, out))).toThrow(/copy\.html is a hard link \(-> index\.html\)[\s\S]*pipe is a FIFO/);
		expect(existsSync(out)).toBe(false);
	});

	test('a failing verify leaves --out absent and removes the staging dir', async () => {
		const artifact = tempDir('packaged');
		await packageBundle(distFixture(), artifact, pin, ours);
		const out = outPath();
		expect(() => importBundle(options(artifact, out, d => {
			expect(readdirSync(d)).toContain('index.html');
			throw new Error(`${d} failed verification`);
		}))).toThrow(/failed verification/);
		expect(leftovers(out)).toEqual([]);
	});

	test('a decompression bomb stops at the bound the manifest allows', () => {
		const root = tempDir('bomb');
		writeFileSync(join(root, 'index.html'), Buffer.alloc(4 * 1024 * 1024));
		const artifact = artifactAround(tarOf(root, ['index.html']), [{ path: 'index.html', sha256: sha256('x'), size: 1 }]);
		expect(() => importBundle(options(artifact, outPath()))).toThrow(/decompresses to more than \d+ bytes/);
	});
});
