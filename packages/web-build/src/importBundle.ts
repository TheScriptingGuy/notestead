// `web-build import <artifact-dir> --out <dist>` (M1-AC28; docs/test-plans/M1-S4.md §Command contracts): installs a
// packaged bundle (CI-built, or written by `package`) as the dist/ the `web` image is built from.
// - Before anything is extracted: SHA256SUMS has a matching line for the tarball and for bundle-manifest.json (a
//   missing line fails); the manifest's upstream repo/tag/commit equal the pin; every tar member is a regular file or a
//   directory with a safe relative path, and every regular file is listed in `files`.
// - Extraction writes the members we parsed ourselves (no tar binary, so no link or path semantics of its own) into a
//   staging dir next to --out, with modes 0644/0755.
// - After extracting: exactly the listed files exist, with their sha256 and size, and `verify` passes. Only then is the
//   staging dir renamed to --out. On any failure the staging dir is removed, so --out stays absent or empty.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { artifactName } from './packageBundle.ts';
import type { Pin } from './pin.ts';
import { memberPathProblem, normalizeMemberPath, readTar } from './tar.ts';
import type { TarMember } from './tar.ts';
import { hashFiles, requireDirectory, sha256 } from './tree.ts';
import type { BundleFile } from './tree.ts';

export const manifestName = 'bundle-manifest.json';
export const sumsName = 'SHA256SUMS';

export interface ImportOptions {
	artifactDir: string;
	out: string;
	pin: Pin;
	// Where the pin came from, for messages.
	pinLabel: string;
	// The `verify` command's check; throws, naming every problem, when the extracted bundle fails it.
	verify: (dist: string) => void;
}

export interface ImportResult {
	tarball: string;
	files: number;
	bytes: number;
}

const problemList = (problems: string[]): string => `\n  - ${problems.join('\n  - ')}`;

// --out must be absent or an empty directory; otherwise nothing is touched.
const checkOut = (out: string): void => {
	if (!existsSync(out)) return;
	const stat = lstatSync(out);
	if (!stat.isDirectory()) throw new Error(`--out ${out} exists and is not a directory; import installs only into an absent or empty directory`);
	if (readdirSync(out).length > 0) throw new Error(`--out ${out} is not empty; import installs only into an absent or empty directory and left it unchanged`);
};

// sha256sum(1) lines: "<64 hex>  <name>" (or " *<name>"). Malformed lines and conflicting duplicates fail.
const parseSums = (path: string): Map<string, string> => {
	const sums = new Map<string, string>();
	readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
		if (line.trim() === '') return;
		const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
		if (!match) throw new Error(`${path} line ${index + 1} is not a sha256sum line: ${JSON.stringify(line.slice(0, 120))}`);
		const [, hash, name] = match;
		const previous = sums.get(name);
		if (previous !== undefined && previous !== hash.toLowerCase()) throw new Error(`${path} has two different lines for ${name}`);
		sums.set(name, hash.toLowerCase());
	});
	return sums;
};

const checkSums = (artifactDir: string, names: string[]): void => {
	const sumsPath = join(artifactDir, sumsName);
	const sums = parseSums(sumsPath);
	for (const name of names) {
		const expected = sums.get(name);
		if (expected === undefined) throw new Error(`${sumsPath} has no line for ${name}; an artifact must checksum ${names.join(' and ')} (refusing an unchecked file)`);
		const actual = sha256(readFileSync(join(artifactDir, name)));
		if (actual !== expected) throw new Error(`${join(artifactDir, name)}: sha256 ${actual} does not match its SHA256SUMS line (${expected}); the artifact was altered or corrupted`);
	}
};

interface Manifest {
	upstream: Record<'repo' | 'tag' | 'commit', unknown>;
	files: BundleFile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const readManifest = (path: string, pin: Pin, pinLabel: string): Manifest => {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(raw) || !isRecord(raw.upstream) || !Array.isArray(raw.files)) throw new Error(`${path} must be an object with "upstream" and "files"`);
	const upstream = raw.upstream;

	const mismatches: string[] = [];
	for (const field of ['repo', 'tag', 'commit'] as const) {
		if (upstream[field] !== pin.web[field]) {
			mismatches.push(`upstream.${field} is ${JSON.stringify(upstream[field])}, but the pin ${pinLabel} has web.${field} ${JSON.stringify(pin.web[field])}`);
		}
	}
	if (mismatches.length > 0) throw new Error(`${path} was not built from the pinned upstream:${problemList(mismatches)}`);

	const problems: string[] = [];
	const seen = new Set<string>();
	const files: BundleFile[] = [];
	raw.files.forEach((entry: unknown, index: number) => {
		const where = `files[${index}]`;
		if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || typeof entry.size !== 'number') {
			problems.push(`${where} must be {"path": string, "sha256": string, "size": number}`);
			return;
		}
		const pathProblem = memberPathProblem(entry.path) ?? (normalizeMemberPath(entry.path) !== entry.path ? 'is not a normalized relative path' : null);
		if (pathProblem !== null) problems.push(`${where} ${entry.path} ${pathProblem}`);
		if (!/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`${where} ${entry.path}: sha256 must be 64 lower-case hex digits`);
		if (!Number.isSafeInteger(entry.size) || entry.size < 0) problems.push(`${where} ${entry.path}: size must be a non-negative integer`);
		if (seen.has(entry.path)) problems.push(`${where} ${entry.path} is listed twice`);
		if (pathProblem === null) seen.add(entry.path);
		files.push({ path: entry.path, sha256: entry.sha256, size: entry.size });
	});
	// A path listed as a file can't also be the directory of another (only safe relative paths reach this loop).
	for (const path of seen) {
		const segments = path.split('/');
		for (let depth = 1; depth < segments.length; depth++) {
			const parent = segments.slice(0, depth).join('/');
			if (seen.has(parent)) problems.push(`files lists ${parent} as a file and as the directory of ${path}`);
		}
	}
	if (problems.length > 0) throw new Error(`${path} has an invalid "files" list:${problemList(problems)}`);
	return { upstream, files };
};

// The tar can't be larger than the listed files plus generous per-entry header room, so a decompression bomb stops
// at that bound instead of filling memory.
const decompressionBound = (files: BundleFile[]): number => files.reduce((total, file) => total + file.size, 0) + files.length * 8192 + 1024 * 1024;

const decompress = (tarball: string, bound: number): Buffer => {
	try {
		return zstdDecompressSync(readFileSync(tarball), { maxOutputLength: bound });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
			throw new Error(`${tarball} decompresses to more than ${bound} bytes, the most the files listed in ${manifestName} can take; refusing it`);
		}
		throw new Error(`${tarball} is not a valid zstd stream: ${(error as Error).message}`);
	}
};

interface Planned {
	member: TarMember;
	path: string;
}

// Every member must be a regular file or a directory with a safe relative path; every file must be listed.
const planExtraction = (tarball: string, members: TarMember[], files: BundleFile[]): Planned[] => {
	const listed = new Set(files.map(file => file.path));
	const problems: string[] = [];
	const plan: Planned[] = [];
	const seenFiles = new Set<string>();
	for (const member of members) {
		const label = `tar member ${member.name}`;
		if (member.type !== 'file' && member.type !== 'directory') {
			const link = member.linkName === '' ? '' : ` (-> ${member.linkName})`;
			problems.push(`${label} is a ${member.type}${link}; an artifact may contain only regular files and directories`);
			continue;
		}
		const path = normalizeMemberPath(member.name);
		if (member.type === 'directory' && (path === '' || path === '.')) continue;
		const pathProblem = memberPathProblem(member.name);
		if (pathProblem !== null) {
			problems.push(`${label} ${pathProblem}`);
			continue;
		}
		if (member.type === 'directory') {
			if (listed.has(path)) problems.push(`${label} is a directory, but ${manifestName} lists ${path} as a file`);
			else plan.push({ member, path });
			continue;
		}
		if (!listed.has(path)) problems.push(`${label} is not listed in ${manifestName} files`);
		else if (seenFiles.has(path)) problems.push(`${label} appears more than once`);
		else plan.push({ member, path });
		seenFiles.add(path);
	}
	if (problems.length > 0) throw new Error(`${tarball} has ${problems.length} member(s) import refuses (nothing was extracted):${problemList(problems)}`);
	return plan;
};

const extract = (archive: Buffer, plan: Planned[], staging: string): void => {
	for (const { member, path } of plan) {
		const target = join(staging, ...path.split('/'));
		if (member.type === 'directory') {
			mkdirSync(target, { recursive: true });
		} else {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, archive.subarray(member.offset, member.offset + member.size), { flag: 'wx' });
		}
	}
	// Readable by the non-root server in the image, whatever the umask (as `package` normalizes them).
	const normalizeModes = (dir: string): void => {
		chmodSync(dir, 0o755);
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) normalizeModes(join(dir, entry.name));
			else chmodSync(join(dir, entry.name), 0o644);
		}
	};
	normalizeModes(staging);
};

// Exactly the listed files, each with its sha256 and size.
const checkExtracted = (staging: string, files: BundleFile[]): void => {
	const extracted = new Map(hashFiles(staging).map(file => [file.path, file]));
	const problems: string[] = [];
	for (const file of files) {
		const got = extracted.get(file.path);
		if (!got) problems.push(`${file.path} is listed in ${manifestName} files but missing from the tarball`);
		else if (got.sha256 !== file.sha256) problems.push(`${file.path}: sha256 ${got.sha256} does not match ${manifestName} (${file.sha256})`);
		else if (got.size !== file.size) problems.push(`${file.path}: size ${got.size} does not match ${manifestName} (${file.size})`);
		extracted.delete(file.path);
	}
	for (const path of extracted.keys()) problems.push(`${path} was extracted but is not listed in ${manifestName} files`);
	if (problems.length > 0) throw new Error(`the extracted bundle does not match ${manifestName} (${problems.length} problem(s)); nothing was installed:${problemList(problems)}`);
};

export const importBundle = (options: ImportOptions): ImportResult => {
	const { artifactDir, out, pin } = options;
	checkOut(out);
	requireDirectory(artifactDir, 'artifact');
	const name = artifactName(pin);
	const tarball = join(artifactDir, name);
	for (const file of [name, manifestName, sumsName]) {
		if (!existsSync(join(artifactDir, file))) {
			const others = readdirSync(artifactDir).filter(entry => /^web-bundle-.*\.tar\.zst$/.test(entry) && entry !== name);
			const hint = file === name && others.length > 0 ? ` (found ${others.join(', ')}: an artifact of another upstream tag than the pin's ${pin.web.tag})` : '';
			throw new Error(`${join(artifactDir, file)} is missing${hint}; an artifact holds ${name}, ${sumsName} and ${manifestName}`);
		}
	}

	checkSums(artifactDir, [name, manifestName]);
	const manifest = readManifest(join(artifactDir, manifestName), pin, options.pinLabel);
	const archive = decompress(tarball, decompressionBound(manifest.files));
	let members: TarMember[];
	try {
		members = readTar(archive);
	} catch (error) {
		throw new Error(`${tarball} is not a valid tar archive: ${(error as Error).message}`);
	}
	const plan = planExtraction(tarball, members, manifest.files);

	mkdirSync(dirname(out), { recursive: true });
	const staging = join(dirname(out), `.${basename(out)}.import-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	try {
		mkdirSync(staging);
		extract(archive, plan, staging);
		checkExtracted(staging, manifest.files);
		options.verify(staging);
		renameSync(staging, out);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return { tarball, files: manifest.files.length, bytes: manifest.files.reduce((total, file) => total + file.size, 0) };
};
