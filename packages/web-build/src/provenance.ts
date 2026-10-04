// Where this build comes from: our repository's public URL and exact commit (ADR-0010 source offer, M1-AC5
// bundle-manifest.json). Read from git, never from the network.
import { git } from './upstreamCopy.ts';

export interface OurSource {
	commit: string;
	// True when the working tree differs from the commit (tracked changes or untracked, non-ignored files).
	dirty: boolean;
}

export const ourSource = (repoRoot: string): OurSource => {
	const commit = git(repoRoot, ['rev-parse', 'HEAD']).toString().trim();
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git rev-parse HEAD in ${repoRoot} returned ${JSON.stringify(commit)}, not a commit`);
	const dirty = git(repoRoot, ['status', '--porcelain']).toString().trim() !== '';
	return { commit, dirty };
};

// The browsable https URL of a git remote, without credentials or a trailing ".git". Accepts https/http URLs,
// ssh://host/path and scp-like "user@host:path". Returns null for anything else (for example a local path).
export const publicRepoUrl = (remote: string): string | null => {
	const trimmed = remote.trim();
	const scpLike = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(trimmed);
	let host: string;
	let path: string;
	if (scpLike) {
		host = scpLike[1];
		path = `/${scpLike[2]}`;
	} else {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return null;
		}
		if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.hostname === '') return null;
		// Drops user:password@ and the port of ssh URLs; keeps an explicit https port.
		host = url.protocol === 'ssh:' ? url.hostname : url.host;
		path = url.pathname;
	}
	path = path.replace(/\/+$/, '').replace(/\.git$/, '');
	if (path === '' || path === '/') return null;
	return `https://${host}${path}`;
};

// Our repository's public URL: NOTESTEAD_SOURCE_REPO if set, otherwise the `origin` remote of `repoRoot`.
export const ourRepoUrl = (repoRoot: string, env: NodeJS.ProcessEnv = process.env): string => {
	const configured = env.NOTESTEAD_SOURCE_REPO;
	let remote = configured;
	if (remote === undefined || remote.trim() === '') {
		try {
			remote = git(repoRoot, ['remote', 'get-url', 'origin']).toString();
		} catch {
			throw new Error(`cannot determine this repository's public URL for the source offer: ${repoRoot} has no "origin" remote. Set NOTESTEAD_SOURCE_REPO=https://…`);
		}
	}
	const url = publicRepoUrl(remote);
	if (url === null) {
		throw new Error(`cannot use ${configured ? 'NOTESTEAD_SOURCE_REPO' : 'the "origin" remote'} as the public repository URL for the source offer (got a non-http(s)/ssh location). Set NOTESTEAD_SOURCE_REPO=https://…`);
	}
	return url;
};
