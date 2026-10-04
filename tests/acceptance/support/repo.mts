// Shared helpers for repo-level acceptance tests (node:test). See docs/testing/strategy.md §3.
// Erasable TypeScript only: Node runs this file through built-in type stripping.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const fixturesDir = join(repoRoot, 'tests', 'fixtures');
export const pinPath = join(repoRoot, 'upstream', 'joplin-version.json');

const minute = 60_000;

export interface RunResult {
	label: string;
	command: string;
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	// stdout + stderr, ANSI-stripped. Assertions on messages use this.
	output: string;
	durationMs: number;
	logFile: string;
}

export interface RunOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

// eslint-disable-next-line no-control-regex -- strips terminal colour codes
const ansiPattern = /\u001b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (s: string): string => s.replace(ansiPattern, '');
export const redact = (s: string): string => s
	.replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]')
	.replace(/(X-API-AUTH:\s*)\S+/gi, '$1[REDACTED]');

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

export const resultsDir = (story: string): string => {
	const dir = join(repoRoot, 'test-results', 'acceptance', story);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', FORCE_COLOR: '0', ...extra };
	// The node:test runner marks its children; a nested `node --test` or Jest must not inherit that.
	delete env.NODE_TEST_CONTEXT;
	delete env.NO_COLOR;
	return env;
};

// Runs a command to completion and writes a log file with the command, exit status, duration and output.
export const run = (story: string, label: string, cmd: string, args: string[], opts: RunOptions = {}): RunResult => {
	const cwd = opts.cwd ?? repoRoot;
	const started = Date.now();
	const r = spawnSync(cmd, args, {
		cwd,
		env: childEnv(opts.env),
		encoding: 'utf8',
		timeout: opts.timeoutMs ?? 10 * minute,
		maxBuffer: 256 * 1024 * 1024,
	});
	const durationMs = Date.now() - started;
	const stdout = r.stdout ?? '';
	const stderr = (r.stderr ?? '') + (r.error ? `\n[spawn error] ${r.error.message}` : '');
	const command = [cmd, ...args].join(' ');
	const logFile = join(resultsDir(story), `${safeName(label)}.log`);
	writeFileSync(logFile, redact([
		`# ${label}`,
		`$ (cd ${cwd} && ${command})`,
		`exit: ${r.status} signal: ${r.signal} duration: ${durationMs} ms`,
		'--- stdout ---', stripAnsi(stdout),
		'--- stderr ---', stripAnsi(stderr),
	].join('\n')));
	return { label, command, code: r.status, signal: r.signal, stdout, stderr, output: stripAnsi(`${stdout}\n${stderr}`), durationMs, logFile };
};

export const yarn = (story: string, label: string, args: string[], opts: RunOptions = {}): RunResult =>
	run(story, label, 'corepack', ['yarn', ...args], opts);

const tail = (s: string, lines = 40): string => s.trimEnd().split('\n').slice(-lines).join('\n');

export const describeRun = (r: RunResult): string =>
	`\`${r.command}\` exited ${r.code}${r.signal ? ` (signal ${r.signal})` : ''} after ${r.durationMs} ms. Log: ${relative(repoRoot, r.logFile)}\n--- last output ---\n${redact(tail(r.output))}`;

export const assertExitZero = (r: RunResult): void => {
	assert.equal(r.code, 0, `expected exit 0. ${describeRun(r)}`);
};

export const assertExitNonZero = (r: RunResult): void => {
	assert.ok(r.signal === null, `command was killed (timeout?). ${describeRun(r)}`);
	assert.ok(r.code !== null && r.code !== 0, `expected a non-zero exit. ${describeRun(r)}`);
};

export const assertOutputIncludes = (r: RunResult, needle: string | RegExp, why: string): void => {
	const ok = typeof needle === 'string' ? r.output.includes(needle) : needle.test(r.output);
	assert.ok(ok, `${why}: expected the output to contain ${String(needle)}. ${describeRun(r)}`);
};

// ---- Scaffold guards: make RED failures say *what* is missing instead of passing by accident. ----

export interface RootManifest {
	name?: string;
	private?: boolean;
	license?: string;
	packageManager?: string;
	workspaces?: string[] | { packages?: string[] };
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

export const readJson = <T,>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export const rootManifest = (): RootManifest => {
	const path = join(repoRoot, 'package.json');
	assert.ok(existsSync(path), `M1-S1 scaffold missing: ${relative(repoRoot, path) || path} does not exist (the yarn 4 workspace root, ADR-0009)`);
	return readJson<RootManifest>(path);
};

export const requireRootScript = (name: string): void => {
	const scripts = rootManifest().scripts ?? {};
	assert.ok(typeof scripts[name] === 'string' && scripts[name].trim() !== '',
		`M1-S1 contract: the root package.json must define the script "${name}" (docs/test-plans/M1-S1.md §Command contracts). Found: ${JSON.stringify(Object.keys(scripts))}`);
};

// Runs `corepack yarn <script> …args` after checking the script exists, so a missing script can never satisfy a negative test.
export const yarnScript = (story: string, label: string, script: string, args: string[] = [], opts: RunOptions = {}): RunResult => {
	requireRootScript(script);
	return yarn(story, label, [script, ...args], opts);
};

export const ensureInstalled = (story: string): void => {
	if (existsSync(join(repoRoot, 'node_modules'))) return;
	rootManifest();
	const r = yarn(story, 'ensure-install', ['install', '--immutable'], { timeoutMs: 30 * minute });
	assertExitZero(r);
};

export interface Pin {
	minor: string;
	web: { repo: string; branch: string; tag: string; commit: string };
	cli: { npm: string; version: string };
	server: { image: string; tag: string };
	syncVersion: number;
}

export const readPin = (): Pin => {
	assert.ok(existsSync(pinPath), `M1-S1 scaffold missing: ${relative(repoRoot, pinPath)} does not exist (ADR-0005)`);
	return readJson<Pin>(pinPath);
};

export interface Workspace {
	dir: string;
	rel: string;
	manifest: RootManifest;
}

export const workspacePackages = (): Workspace[] => {
	const packagesDir = join(repoRoot, 'packages');
	if (!existsSync(packagesDir)) return [];
	return readdirSync(packagesDir)
		.sort()
		.map(name => join(packagesDir, name))
		.filter(dir => existsSync(join(dir, 'package.json')))
		.map(dir => ({ dir, rel: relative(repoRoot, dir), manifest: readJson<RootManifest>(join(dir, 'package.json')) }));
};

// Recursively lists files under `dir`, skipping dependency and build output directories.
export const listFiles = (dir: string): string[] => {
	const skip = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const entry of readdirSync(d)) {
			if (skip.has(entry)) continue;
			const p = join(d, entry);
			if (statSync(p).isDirectory()) walk(p);
			else out.push(p);
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
};

export const gitStatus = (cwd: string = repoRoot): string => {
	const r = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8' });
	assert.equal(r.status, 0, `git status failed: ${r.stderr}`);
	return r.stdout;
};

export const git = (cwd: string, args: string[]): string => {
	const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	assert.equal(r.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
	return r.stdout;
};

export const makeTempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), `${prefix}-`));
export const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

// Temporarily places files inside the repo (for lint negatives). Returns a cleanup function that removes
// every file and every directory it created, newest first.
export const placeTemporarily = (files: { from: string; to: string }[]): (() => void) => {
	const createdDirs: string[] = [];
	const createdFiles: string[] = [];
	const mkdirTracked = (dir: string): void => {
		if (existsSync(dir)) return;
		mkdirTracked(dirname(dir));
		mkdirSync(dir);
		createdDirs.push(dir);
	};
	for (const { from, to } of files) {
		assert.ok(!existsSync(to), `refusing to overwrite an existing file: ${to}`);
		mkdirTracked(dirname(to));
		writeFileSync(to, readFileSync(from));
		createdFiles.push(to);
	}
	return () => {
		for (const f of createdFiles.reverse()) rmSync(f, { force: true });
		for (const d of createdDirs.reverse()) rmSync(d, { recursive: true, force: true });
	};
};

// True when `rule` is reported for `fileFragment`, for both eslint's stylish formatter (file header line followed
// by indented messages) and single-line formatters (compact/unix/tsc: path and message on one line).
export const lintReported = (output: string, fileFragment: string, rule: string): boolean => {
	let currentFile = '';
	for (const line of output.split('\n')) {
		if (line.includes(fileFragment) && line.includes(rule)) return true;
		if (/^\S/.test(line) && /[\\/]/.test(line)) currentFile = line;
		if (line.includes(rule) && currentFile.includes(fileFragment)) return true;
	}
	return false;
};

// Directory holding a local clone of the upstream repo, if any (used only to *generate* fixtures at test time).
export const upstreamCloneDir = (): string | null => {
	const candidates = [process.env.JOPLIN_UPSTREAM_DIR, join(homedir(), 'joplin-web-app-work', 'upstream-joplin')];
	for (const c of candidates) if (c && existsSync(join(c, '.git'))) return c;
	return null;
};
