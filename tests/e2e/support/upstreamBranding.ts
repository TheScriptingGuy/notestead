// Upstream's static branding at the pinned web.commit, read through git at test time and never written into the repository
// (docs/test-plans/M2-S6.md D1; CLAUDE.md "reuse, never fork" and the trademark rule): the files of
// upstream:packages/app-mobile/web/public/** and the sha256 of its icons and screenshots, computed in memory. The lookup is
// the acceptance suite's (JOPLIN_UPSTREAM_DIR, the local clone, else a blobless fetch cached under test-results/.cache/).
import { sha256, upstreamPublicFiles } from '../../acceptance/support/upstream.mts';
import { readVersionPin } from '../../support/repoRoot.ts';

// Every file of upstream's public/ at the pin, keyed by its path relative to public/ (for example `icons/icon-large.png`).
export const upstreamPublic = (): Map<string, Buffer> => upstreamPublicFiles();

const hashesUnder = (prefix: string, expected: number): Map<string, string> => {
	const hashes = new Map<string, string>();
	for (const [path, content] of upstreamPublic()) if (path.startsWith(prefix)) hashes.set(sha256(content), path);
	if (hashes.size !== expected) {
		const { web } = readVersionPin();
		throw new Error(`upstream ${prefix}* at ${web.tag} (${web.commit}) has ${hashes.size} distinct files, expected ${expected}: the pin changed upstream's public/ layout, so the M2-S6 branding checks need review`);
	}
	return hashes;
};

// sha256 -> `icons/<name>` for upstream's six icons.
export const upstreamIconHashes = (): Map<string, string> => hashesUnder('icons/', 6);

// sha256 -> `screenshots/<name>` for upstream's two manifest screenshots.
export const upstreamScreenshotHashes = (): Map<string, string> => hashesUnder('screenshots/', 2);
