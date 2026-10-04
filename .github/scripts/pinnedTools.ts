// Pinned external linters for `check:workflows` (actionlint, shellcheck): resolve the binary, download and verify it
// on first use, and check the version it reports, so the Pi and CI always get the same findings (M1-AC8).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface ToolAsset {
	url: string;
	sha256: string;
}

export interface PinnedTool {
	version: string;
	member: string;
	assets: Record<string, ToolAsset>;
}

export type ToolName = 'actionlint' | 'shellcheck';

export const pinnedToolsFile = join(import.meta.dirname, 'pinned-tools.json');

export const readPinnedTools = (): Record<ToolName, PinnedTool> =>
	JSON.parse(readFileSync(pinnedToolsFile, 'utf8')) as Record<ToolName, PinnedTool>;

// Variables that override the managed binary (the version check still applies).
export const overrideVariable: Record<ToolName, string> = { actionlint: 'ACTIONLINT', shellcheck: 'SHELLCHECK' };

const versionArgs: Record<ToolName, string> = { actionlint: '-version', shellcheck: '--version' };

export const toolsCacheDir = (env: NodeJS.ProcessEnv = process.env): string =>
	join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'notestead', 'tools');

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

// Downloads the pinned release tarball for this machine, verifies its sha256 and extracts the binary into the cache.
const download = async (name: ToolName, tool: PinnedTool, target: string, log: (line: string) => void): Promise<void> => {
	const asset = process.platform === 'linux' ? tool.assets[process.arch] : undefined;
	if (!asset) {
		throw new Error(`no pinned ${name} ${tool.version} release for ${process.platform}/${process.arch}; set ${overrideVariable[name]}=<path to ${name} ${tool.version}>`);
	}
	log(`check:workflows: downloading ${name} ${tool.version} from ${asset.url}`);
	let data: Buffer;
	try {
		const response = await fetch(asset.url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		data = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw new Error(`could not download ${asset.url} (${(error as Error).message}); set ${overrideVariable[name]}=<path to ${name} ${tool.version}> to run offline`);
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
		chmodSync(join(temporary, tool.member), 0o755);
		renameSync(join(temporary, tool.member), target);
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

// Resolves the binary (override variable, else the managed download), checks its version and returns its path.
export const resolveTool = async (name: ToolName, tool: PinnedTool, log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<string> => {
	const override = env[overrideVariable[name]];
	let bin: string;
	if (override) {
		if (!existsSync(override)) throw new Error(`${name} not found at ${override} (from ${overrideVariable[name]}); nothing was checked`);
		bin = resolve(override);
	} else {
		bin = join(toolsCacheDir(env), `${name}-${tool.version}`, basename(tool.member));
		if (!existsSync(bin)) await download(name, tool, bin, log);
	}
	const version = reportedVersion(name, bin);
	if (version !== tool.version) {
		throw new Error(`${bin} is ${name} ${version}, but check:workflows pins ${name} ${tool.version} (.github/scripts/pinned-tools.json), so the Pi and CI would disagree; nothing was checked`);
	}
	log(`${name} ${version} (${bin})`);
	return bin;
};
