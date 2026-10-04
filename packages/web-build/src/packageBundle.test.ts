import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { artifactName, packageBundle } from './packageBundle.ts';
import type { BundleManifest } from './packageBundle.ts';
import { distFixture, pinFor, removeTempDirs, tempDir } from './testing/fixtures.ts';
import { hashFiles, sha256 } from './tree.ts';

const pin = pinFor('https://example.org/upstream.git', 'a'.repeat(40), 'v1.2.3');
const ours = { commit: 'b'.repeat(40), dirty: false };

const tar = (args: string[]): string => {
	const result = spawnSync('tar', args, { encoding: 'utf8' });
	expect(result.status).toBe(0);
	return result.stdout;
};

describe('packageBundle', () => {
	afterAll(removeTempDirs);

	test('writes the tarball, bundle-manifest.json and SHA256SUMS for exactly the bundle files', async () => {
		const dist = distFixture();
		const out = join(tempDir('out'), 'nested', 'out');
		const result = await packageBundle(dist, out, pin, ours);
		expect(result.tarball).toBe(join(out, 'web-bundle-v1.2.3.tar.zst'));
		expect(readdirSync(out).sort()).toEqual(['SHA256SUMS', 'bundle-manifest.json', artifactName(pin)]);

		const listing = tar(['--zstd', '-tvf', result.tarball]).trim().split('\n');
		expect(listing.every(line => line.startsWith('-') && line.includes(' 0/0 '))).toBe(true);
		const extracted = tempDir('extract');
		tar(['--zstd', '-xf', result.tarball, '-C', extracted]);
		expect(hashFiles(extracted)).toEqual(hashFiles(dist));

		const manifest: BundleManifest = JSON.parse(readFileSync(join(out, 'bundle-manifest.json'), 'utf8'));
		expect(manifest.upstream).toEqual({ repo: pin.web.repo, tag: 'v1.2.3', commit: pin.web.commit });
		expect(manifest.notestead).toEqual(ours);
		expect(manifest.files).toEqual(hashFiles(dist));
		expect(manifest.files.map(file => file.path)).toEqual(manifest.files.map(file => file.path).sort());

		expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toBe([
			`${sha256(readFileSync(join(out, 'bundle-manifest.json')))}  bundle-manifest.json`,
			`${sha256(readFileSync(result.tarball))}  web-bundle-v1.2.3.tar.zst`,
			'',
		].join('\n'));
	});

	test('normalizes file modes to 0644 (0755 when executable), whatever the builder\'s umask left', async () => {
		const dist = distFixture();
		chmodSync(join(dist, 'index.html'), 0o600);
		chmodSync(join(dist, 'app.bundle.js'), 0o660);
		chmodSync(join(dist, 'environment.js'), 0o700);
		const { tarball } = await packageBundle(dist, join(tempDir('out'), 'out'), pin, ours);
		const modes = new Map(tar(['--zstd', '-tvf', tarball]).trim().split('\n').map(line => [line.split(/\s+/).pop(), line.slice(0, 10)]));
		expect(modes.get('index.html')).toBe('-rw-r--r--');
		expect(modes.get('app.bundle.js')).toBe('-rw-r--r--');
		expect(modes.get('environment.js')).toBe('-rwxr-xr-x');
		expect(new Set(modes.values())).toEqual(new Set(['-rw-r--r--', '-rwxr-xr-x']));
	});

	test('refuses a missing dist, a dist without index.html and symlinks, writing no tarball', async () => {
		const out = join(tempDir('out'), 'out');
		const missing = join(tempDir('none'), 'dist');
		await expect(packageBundle(missing, out, pin, ours)).rejects.toThrow(`dist ${missing} does not exist`);

		const noIndex = tempDir('no-index');
		await expect(packageBundle(noIndex, out, pin, ours)).rejects.toThrow('has no index.html at its root');

		const linked = distFixture();
		symlinkSync('/etc/hostname', join(linked, 'link.txt'));
		await expect(packageBundle(linked, out, pin, ours)).rejects.toThrow(`${join(linked, 'link.txt')} is not a regular file or directory`);
		expect(existsSync(out)).toBe(false);
	});
});
