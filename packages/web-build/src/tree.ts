// Walks a built bundle directory (the upstream `dist/`). Paths are POSIX and relative to the bundle root, sorted with
// plain JS string comparison (the order bundle-manifest.json uses). Anything that is neither a regular file nor a
// directory (symlinks, devices, sockets) is an error: an artifact holds regular files only (M1-AC5).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface BundleFile {
	path: string;
	sha256: string;
	size: number;
}

export const sha256 = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex');

// Throws, naming `dir`, unless it is an existing directory.
export const requireDirectory = (dir: string, what: string): void => {
	let isDirectory = false;
	try {
		isDirectory = statSync(dir).isDirectory();
	} catch {
		throw new Error(`${what} ${dir} does not exist`);
	}
	if (!isDirectory) throw new Error(`${what} ${dir} is not a directory`);
};

export const listFiles = (root: string): string[] => {
	const files: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(dir, entry.name), path);
			else if (entry.isFile()) files.push(path);
			else throw new Error(`${join(dir, entry.name)} is not a regular file or directory; a bundle may only contain regular files`);
		}
	};
	walk(root, '');
	return files.sort();
};

export const hashFiles = (root: string): BundleFile[] => listFiles(root).map(path => {
	const content = readFileSync(join(root, ...path.split('/')));
	return { path, sha256: sha256(content), size: content.length };
});
