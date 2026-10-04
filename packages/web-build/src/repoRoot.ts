// Locates the repository root (the directory holding upstream/joplin-version.json) from a starting directory.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const pinRelativePath = join('upstream', 'joplin-version.json');

export const findRepoRoot = (startDir: string): string => {
	let dir = resolve(startDir);
	for (;;) {
		if (existsSync(join(dir, pinRelativePath)) && existsSync(join(dir, 'package.json'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`no ${pinRelativePath} found in ${startDir} or any parent directory`);
		dir = parent;
	}
};
