// Berry yarn.lock reader for the M1-S5 image checks (M1-AC23): which name@version pairs the lockfile allows. A Berry
// lockfile is YAML; every entry has `resolution: "<name>@<protocol>:<ref>"` and `version`. Workspaces resolve to
// `<name>@workspace:<path>` and are allowed at any version (an installed workspace carries its manifest's version).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface LockIndex {
	versions: Map<string, Set<string>>;
	workspaces: Set<string>;
	entries: Map<string, { resolution: string; version: string }>;
}

export const nameOfResolution = (resolution: string): string => resolution.slice(0, resolution.indexOf('@', 1));

export const readLock = (file: string): LockIndex => {
	const doc = parse(readFileSync(file, 'utf8')) as Record<string, { resolution?: string; version?: string }>;
	const versions = new Map<string, Set<string>>();
	const workspaces = new Set<string>();
	const entries = new Map<string, { resolution: string; version: string }>();
	for (const [key, entry] of Object.entries(doc)) {
		if (key === '__metadata' || !entry?.resolution) continue;
		const name = nameOfResolution(entry.resolution);
		entries.set(key, { resolution: entry.resolution, version: String(entry.version) });
		if (entry.resolution.slice(name.length + 1).startsWith('workspace:')) workspaces.add(name);
		const set = versions.get(name) ?? new Set<string>();
		set.add(String(entry.version));
		versions.set(name, set);
	}
	return { versions, workspaces, entries };
};

export const lockAllows = (lock: LockIndex, name: string, version: string): boolean =>
	lock.workspaces.has(name) || (lock.versions.get(name)?.has(version) ?? false);
