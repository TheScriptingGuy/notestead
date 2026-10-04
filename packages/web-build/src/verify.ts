// Checks an overlaid bundle (ADR-0010 verify step, M1-AC7):
// - no file, under any name and at any depth, has the sha256 of an upstream icon
//   (upstream:packages/app-mobile/web/public/icons/* at the pinned web.commit);
// - environment.js is the overlay's (React Native dev mode off on every origin);
// - the CSP <meta> of index.html is byte-identical to upstream's at web.commit;
// - third-party-notices.txt exists and source.html links it (ADR-0010, M1-AC29).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cspMetas } from './html.ts';
import { hashFiles, sha256 } from './tree.ts';
import { git } from './upstreamCopy.ts';

export const upstreamPublicDir = 'packages/app-mobile/web/public';
export const upstreamIconsDir = `${upstreamPublicDir}/icons`;

const splitNul = (output: Buffer): string[] => output.toString('utf8').split('\0').filter(entry => entry !== '');

// sha256 → upstream path, for every file under upstream:packages/app-mobile/web/public/icons at `commit`.
// Blob contents are read through git, so a blobless clone fetches just these few files on first use.
export const upstreamIconHashes = (gitDir: string, commit: string): Map<string, string> => {
	const hashes = new Map<string, string>();
	for (const entry of splitNul(git(gitDir, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', upstreamIconsDir]))) {
		const tab = entry.indexOf('\t');
		const [, type, objectId] = entry.slice(0, tab).split(' ');
		if (type !== 'blob') continue;
		hashes.set(sha256(git(gitDir, ['cat-file', 'blob', objectId])), entry.slice(tab + 1));
	}
	if (hashes.size === 0) throw new Error(`upstream ${upstreamIconsDir} at ${commit} has no files; the icon check cannot run`);
	return hashes;
};

export const upstreamFile = (gitDir: string, commit: string, path: string): Buffer =>
	git(gitDir, ['cat-file', 'blob', `${commit}:${path}`]);

export interface VerifyInput {
	dist: string;
	iconHashes: Map<string, string>;
	// The environment.js the overlay installs, and upstream's index.html at web.commit.
	overlayEnvironment: Buffer;
	upstreamIndexHtml: string;
}

// Returns one problem per finding, each naming the offending bundle path. Throws if `dist` cannot be read.
export const verifyBundle = (input: VerifyInput): string[] => {
	const problems: string[] = [];
	const files = hashFiles(input.dist);
	const paths = new Set(files.map(file => file.path));

	for (const file of files) {
		const upstreamPath = input.iconHashes.get(file.sha256);
		if (upstreamPath) problems.push(`${file.path} is byte-identical to the upstream icon upstream:${upstreamPath} (sha256 ${file.sha256})`);
	}

	if (!paths.has('environment.js')) {
		problems.push('environment.js is missing');
	} else if (!readFileSync(join(input.dist, 'environment.js')).equals(input.overlayEnvironment)) {
		problems.push('environment.js is not the overlay\'s (React Native dev mode must be off on every origin; run the overlay)');
	}

	if (!paths.has('index.html')) {
		problems.push('index.html is missing');
	} else {
		const ours = cspMetas(readFileSync(join(input.dist, 'index.html'), 'utf8'));
		const upstream = cspMetas(input.upstreamIndexHtml);
		if (upstream.length !== 1) {
			problems.push(`upstream index.html has ${upstream.length} Content-Security-Policy <meta> elements; expected exactly one`);
		} else if (ours.length !== 1 || ours[0] !== upstream[0]) {
			problems.push('index.html: the Content-Security-Policy <meta> differs from upstream\'s at web.commit (it must stay byte-identical)');
		}
	}
	if (!paths.has('third-party-notices.txt')) {
		problems.push('third-party-notices.txt is missing (`build` writes it with `notices` before the overlay; ADR-0010)');
	}
	if (!paths.has('source.html')) {
		problems.push('source.html is missing (the overlay generates it; ADR-0010)');
	} else if (!/href\s*=\s*["'](?:\.\/)?third-party-notices\.txt["']/.test(readFileSync(join(input.dist, 'source.html'), 'utf8'))) {
		problems.push('source.html does not link third-party-notices.txt (run the overlay after `notices`; ADR-0010)');
	}
	return problems;
};
