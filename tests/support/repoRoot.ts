// The repository root, found by walking up from the working directory. Shared by Jest (CommonJS), Playwright (ESM)
// and plain Node scripts, so it can use neither __dirname nor import.meta. Every runner starts in the repository (the
// root `package.json` scripts, `corepack yarn …`).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const findRepoRoot = (from: string = process.cwd()): string => {
	let dir = resolve(from);
	for (;;) {
		if (existsSync(join(dir, 'upstream', 'joplin-version.json')) && existsSync(join(dir, 'package.json'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`not inside the Notestead repository: no upstream/joplin-version.json above ${from}`);
		dir = parent;
	}
};

export interface VersionPin {
	web: { repo: string; tag: string; commit: string };
	cli: { npm: string; version: string };
	server: { image: string; tag: string };
	syncVersion: number;
}

export const readVersionPin = (root: string = findRepoRoot()): VersionPin =>
	JSON.parse(readFileSync(join(root, 'upstream', 'joplin-version.json'), 'utf8')) as VersionPin;
