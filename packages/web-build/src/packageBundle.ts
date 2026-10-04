// Packages a bundle directory into the M1-AC5 artifact (ADR-0001 §2):
// - web-bundle-<web.tag>.tar.zst: a POSIX tar of the bundle's regular files (paths relative to the bundle root,
//   numeric owner 0:0, modes 0644/0755 whatever the builder's umask, so a non-root server can read them), compressed
//   with zstd;
// - bundle-manifest.json: the upstream repo/tag/commit, our commit and every file with its sha256 and size;
// - SHA256SUMS: sha256sum(1) lines for the tarball and the manifest.
// tar is GNU tar (as on the Pi and ubuntu runners); zstd is Node's built-in zlib zstd (no extra binary or package).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress } from 'node:zlib';
import type { Pin } from './pin.ts';
import type { OurSource } from './provenance.ts';
import { hashFiles, requireDirectory, sha256 } from './tree.ts';
import type { BundleFile } from './tree.ts';

export const artifactName = (pin: Pin): string => `web-bundle-${pin.web.tag}.tar.zst`;

export interface BundleManifest {
	upstream: { repo: string; tag: string; commit: string };
	notestead: { commit: string; dirty: boolean };
	files: BundleFile[];
}

export interface PackageResult {
	tarball: string;
	files: number;
	bytes: number;
}

// zstd level 9: measured on the Pi for the 29.8 MB v3.7.21 tar: 9.6 MB in 2.4 s (level 19: 8.9 MB in 24.5 s; level 3:
// 10.6 MB in 1.1 s). docs/worklog/M1-S2.md.
const zstdLevel = 9;

const tarArgs = (dist: string): string[] => [
	'--create', '--file=-', `--directory=${dist}`,
	'--format=posix', '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
	'--owner=0', '--group=0', '--numeric-owner', '--mode=u=rwX,go=rX',
	'--no-recursion', '--null', '--verbatim-files-from', '--files-from=-',
];

// Writes the tar of `paths` (relative to `dist`) through zstd into `target`.
const writeTarZst = async (dist: string, paths: string[], target: string): Promise<void> => {
	const tar = spawn('tar', tarArgs(dist), { stdio: ['pipe', 'pipe', 'pipe'] });
	let stderr = '';
	tar.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
	const exited = new Promise<number | null>((resolve, reject) => {
		tar.on('error', reject);
		tar.on('close', code => resolve(code));
	});
	tar.stdin.end(paths.map(path => `${path}\0`).join(''));
	const compress = createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: zstdLevel, [constants.ZSTD_c_checksumFlag]: 1 } });
	const [code] = await Promise.all([exited, pipeline(tar.stdout, compress, createWriteStream(target))]);
	if (code !== 0) throw new Error(`tar exited with ${code} while packaging ${dist}: ${stderr.trim()}`);
};

export const packageBundle = async (dist: string, outDir: string, pin: Pin, ours: OurSource): Promise<PackageResult> => {
	requireDirectory(dist, 'dist');
	const files = hashFiles(dist);
	if (!files.some(file => file.path === 'index.html')) throw new Error(`${dist} has no index.html at its root; is it a built bundle?`);

	mkdirSync(outDir, { recursive: true });
	const name = artifactName(pin);
	const tarball = join(outDir, name);
	const partial = join(outDir, `.${name}.partial-${process.pid}`);
	try {
		await writeTarZst(dist, files.map(file => file.path), partial);
		const manifest: BundleManifest = {
			upstream: { repo: pin.web.repo, tag: pin.web.tag, commit: pin.web.commit },
			notestead: { commit: ours.commit, dirty: ours.dirty },
			files,
		};
		const manifestText = `${JSON.stringify(manifest, null, '\t')}\n`;
		const sums = [[name, sha256(readFileSync(partial))], ['bundle-manifest.json', sha256(manifestText)]]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([file, hash]) => `${hash}  ${file}\n`)
			.join('');
		writeFileSync(join(outDir, 'bundle-manifest.json'), manifestText);
		writeFileSync(join(outDir, 'SHA256SUMS'), sums);
		renameSync(partial, tarball);
	} finally {
		rmSync(partial, { force: true });
	}
	return { tarball, files: files.length, bytes: files.reduce((total, file) => total + file.size, 0) };
};
