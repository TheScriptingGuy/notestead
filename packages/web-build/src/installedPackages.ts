// The installed packages of a yarn (node-modules linker) tree: `<root>/node_modules` and the `node_modules` of every
// workspace declared by `<root>/package.json` (this repo and upstream use `nmHoistingLimits: workspaces`, so most of
// a workspace's tree sits in its own node_modules), recursively through nested node_modules.
// A package is a directory directly under `node_modules/` or `node_modules/@scope/` holding a package.json; a
// package.json deeper inside a package (for example `dist/package.json`) is not a package. Symlinks (workspace links)
// are not followed.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface InstalledPackage {
	name: string;
	version: string;
	// The package directory, absolute and relative to the tree root (POSIX).
	dir: string;
	rel: string;
	manifest: Record<string, unknown>;
	// Set when the package.json could not be read; name and version then come from the directory.
	manifestError: string | null;
}

const toPosix = (path: string): string => path.split(sep).join('/');

const readManifest = (path: string): Record<string, unknown> => {
	const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
	if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('package.json is not a JSON object');
	return data as Record<string, unknown>;
};

// Workspace directories (absolute) declared by `<root>/package.json` `workspaces`: plain paths and `dir/*` globs,
// the forms yarn's own workspaces use. Any other glob is refused rather than half-understood.
export const workspaceDirs = (root: string): string[] => {
	const path = join(root, 'package.json');
	if (!existsSync(path)) return [];
	const manifest = readManifest(path) as { workspaces?: unknown };
	const declared = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces as { packages?: unknown } | undefined)?.packages;
	if (declared === undefined) return [];
	if (!Array.isArray(declared) || !declared.every(p => typeof p === 'string')) throw new Error(`${path}: "workspaces" must be a list of paths`);
	const dirs: string[] = [];
	for (const pattern of declared as string[]) {
		const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
		if (clean.endsWith('/*') && !clean.slice(0, -2).includes('*')) {
			const parent = join(root, clean.slice(0, -2));
			if (!existsSync(parent)) continue;
			for (const entry of readdirSync(parent).sort()) {
				const dir = join(parent, entry);
				if (lstatSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir);
			}
		} else if (!clean.includes('*')) {
			if (existsSync(join(root, clean, 'package.json'))) dirs.push(join(root, clean));
		} else {
			throw new Error(`${path}: unsupported workspaces pattern ${JSON.stringify(pattern)} (only "dir/*" and plain paths)`);
		}
	}
	return dirs;
};

export const installedPackages = (root: string): InstalledPackage[] => {
	const found: InstalledPackage[] = [];
	const visitPackage = (dir: string, dirName: string): void => {
		const stats = lstatSync(dir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return;
		const manifestPath = join(dir, 'package.json');
		if (existsSync(manifestPath)) {
			let manifest: Record<string, unknown> = {};
			let manifestError: string | null = null;
			try {
				manifest = readManifest(manifestPath);
			} catch (error) {
				manifestError = (error as Error).message;
			}
			found.push({
				name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : dirName,
				version: typeof manifest.version === 'string' ? manifest.version : '',
				dir,
				rel: toPosix(relative(root, dir)),
				manifest,
				manifestError,
			});
		}
		walk(join(dir, 'node_modules'));
	};
	const walk = (nodeModules: string): void => {
		if (!existsSync(nodeModules)) return;
		for (const entry of readdirSync(nodeModules).sort()) {
			if (entry.startsWith('.')) continue;
			const path = join(nodeModules, entry);
			if (entry.startsWith('@')) {
				if (!lstatSync(path).isDirectory()) continue;
				for (const scoped of readdirSync(path).sort()) visitPackage(join(path, scoped), `${entry}/${scoped}`);
			} else {
				visitPackage(path, entry);
			}
		}
	};
	walk(join(root, 'node_modules'));
	for (const workspace of workspaceDirs(root)) walk(join(workspace, 'node_modules'));
	return found;
};

export const packageKey = (name: string, version: string): string => `${name}@${version}`;
