// Pinned external linters for `check:workflows` (actionlint, shellcheck): resolve the binary, download and verify it
// on first use, and check the version it reports, so the Pi and CI always get the same findings (M1-AC8).
// M1-AC33 (review M1-S3-r1 C4, C5): the managed binary's own sha256 (`binarySha256`) is checked on every run, cached or
// freshly extracted, before it is ever executed; a fresh binary that does not match never reaches the cache. Each
// download is bounded by a 120 s deadline, whatever the transport does. The seams `deps.fetch` and `deps.deadline`
// let the tests drive both without a network or a real clock.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface ToolAsset {
	url: string;
	// the release tarball's sha256
	sha256: string;
	// the extracted binary's (`member`) sha256; required for the managed binary
	binarySha256?: string;
}

export interface PinnedTool {
	version: string;
	member: string;
	assets: Record<string, ToolAsset>;
}

export type ToolName = 'actionlint' | 'shellcheck';

// The download deadline (M1-AC33): a stalled connection must not hang `check:workflows` (or a CI job) forever.
export const downloadTimeoutMs = 120_000;

export interface FetchResponse {
	ok: boolean;
	status: number;
	arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface ResolveDeps {
	// default: the global fetch
	fetch?: (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;
	// default: AbortSignal.timeout; called once per download with downloadTimeoutMs
	deadline?: (ms: number) => AbortSignal;
}

export const pinnedToolsFile = join(import.meta.dirname, 'pinned-tools.json');

export const readPinnedTools = (): Record<ToolName, PinnedTool> =>
	JSON.parse(readFileSync(pinnedToolsFile, 'utf8')) as Record<ToolName, PinnedTool>;

// Variables that override the managed binary (the version check still applies).
export const overrideVariable: Record<ToolName, string> = { actionlint: 'ACTIONLINT', shellcheck: 'SHELLCHECK' };

const versionArgs: Record<ToolName, string> = { actionlint: '-version', shellcheck: '--version' };

export const toolsCacheDir = (env: NodeJS.ProcessEnv = process.env): string =>
	join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'notestead', 'tools');

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const offlineHint = (name: ToolName, tool: PinnedTool): string => `set ${overrideVariable[name]}=<path to ${name} ${tool.version}> to run offline`;

// The pinned asset for this machine, with a well-formed binarySha256 (fail closed without one).
const assetFor = (name: ToolName, tool: PinnedTool): ToolAsset & { binarySha256: string } => {
	const asset = process.platform === 'linux' ? tool.assets[process.arch] : undefined;
	if (!asset) {
		throw new Error(`no pinned ${name} ${tool.version} release for ${process.platform}/${process.arch}; set ${overrideVariable[name]}=<path to ${name} ${tool.version}>`);
	}
	if (!/^[0-9a-f]{64}$/.test(asset.binarySha256 ?? '')) {
		throw new Error(`.github/scripts/pinned-tools.json pins no binarySha256 (64 lowercase hex) for ${name} ${tool.version} on ${process.arch}, so the binary cannot be verified; refusing to run it`);
	}
	return asset as ToolAsset & { binarySha256: string };
};

// Fetches the URL and reads the body, rejecting when the deadline signal aborts, even if the fetch ignores the signal.
const fetchWithDeadline = async (url: string, deps: ResolveDeps): Promise<Buffer> => {
	const signal = (deps.deadline ?? AbortSignal.timeout)(downloadTimeoutMs);
	const fetchFn = deps.fetch ?? fetch;
	let onAbort: () => void = () => undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error(`timed out after ${downloadTimeoutMs / 1000} s`));
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	});
	aborted.catch(() => undefined); // only ever observed through the races below
	try {
		const response = await Promise.race([fetchFn(url, { signal }), aborted]);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return Buffer.from(await Promise.race([response.arrayBuffer(), aborted]));
	} catch (error) {
		if (signal.aborted) throw new Error(`timed out after ${downloadTimeoutMs / 1000} s`);
		throw error;
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
};

// Downloads the pinned release tarball for this machine, verifies its sha256, extracts the binary, verifies the
// binary's sha256 and only then moves it into the cache. Nothing is executed here.
const download = async (name: ToolName, tool: PinnedTool, asset: ToolAsset & { binarySha256: string }, target: string, log: (line: string) => void, deps: ResolveDeps): Promise<void> => {
	log(`check:workflows: downloading ${name} ${tool.version} from ${asset.url}`);
	let data: Buffer;
	try {
		data = await fetchWithDeadline(asset.url, deps);
	} catch (error) {
		throw new Error(`could not download ${asset.url} (${(error as Error).message}); ${offlineHint(name, tool)}`);
	}
	const actual = sha256(data);
	if (actual !== asset.sha256) {
		throw new Error(`${asset.url} has sha256 ${actual}, but .github/scripts/pinned-tools.json pins ${asset.sha256}; refusing to run it`);
	}
	const dir = join(target, '..');
	mkdirSync(dir, { recursive: true });
	const temporary = mkdtempSync(join(dir, '.download-'));
	try {
		const tarball = join(temporary, basename(new URL(asset.url).pathname));
		writeFileSync(tarball, data);
		const r = spawnSync('tar', ['-xzf', tarball, '-C', temporary, '--', tool.member], { encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`could not extract ${tool.member} from ${tarball}: ${r.error?.message ?? r.stderr.trim()}`);
		const extracted = join(temporary, tool.member);
		const binaryHash = sha256(readFileSync(extracted));
		if (binaryHash !== asset.binarySha256) {
			throw new Error(`${tool.member} extracted from ${asset.url} has sha256 ${binaryHash}, but .github/scripts/pinned-tools.json pins binarySha256 ${asset.binarySha256}; refusing to run or cache it`);
		}
		chmodSync(extracted, 0o755);
		renameSync(extracted, target);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
};

// The version a binary reports: actionlint prints it on the first line of `-version`, shellcheck as `version: x.y.z`.
export const reportedVersion = (name: ToolName, bin: string): string => {
	const r = spawnSync(bin, [versionArgs[name]], { encoding: 'utf8', timeout: 30_000 });
	if (r.error || r.status !== 0) {
		throw new Error(`could not run ${bin} ${versionArgs[name]}: ${r.error?.message ?? `exit ${r.status}: ${(r.stderr ?? '').trim()}`}`);
	}
	const lines = r.stdout.split('\n').map(line => line.trim()).filter(line => line !== '');
	const version = name === 'shellcheck'
		? lines.find(line => line.startsWith('version:'))?.slice('version:'.length).trim()
		: lines[0];
	if (!version) throw new Error(`${bin} ${versionArgs[name]} printed no version`);
	return version;
};

// Resolves the binary (override variable, else the managed download), checks its version and returns its path. The
// managed binary is hashed before it is executed, on every run; an override keeps the version check only.
export const resolveTool = async (name: ToolName, tool: PinnedTool, log: (line: string) => void, env: NodeJS.ProcessEnv = process.env, deps: ResolveDeps = {}): Promise<string> => {
	const override = env[overrideVariable[name]];
	let bin: string;
	if (override) {
		if (!existsSync(override)) throw new Error(`${name} not found at ${override} (from ${overrideVariable[name]}); nothing was checked`);
		bin = resolve(override);
	} else {
		const asset = assetFor(name, tool);
		bin = join(toolsCacheDir(env), `${name}-${tool.version}`, basename(tool.member));
		if (existsSync(bin)) {
			const actual = sha256(readFileSync(bin));
			if (actual !== asset.binarySha256) {
				throw new Error(`the cached ${bin} has sha256 ${actual}, but .github/scripts/pinned-tools.json pins binarySha256 ${asset.binarySha256}; it was not run. Remove ${join(bin, '..')} to download it again, or ${offlineHint(name, tool)}`);
			}
		} else {
			await download(name, tool, asset, bin, log, deps);
		}
	}
	const version = reportedVersion(name, bin);
	if (version !== tool.version) {
		throw new Error(`${bin} is ${name} ${version}, but check:workflows pins ${name} ${tool.version} (.github/scripts/pinned-tools.json), so the Pi and CI would disagree; nothing was checked`);
	}
	log(`${name} ${version} (${bin})`);
	return bin;
};
