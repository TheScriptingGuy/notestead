// `corepack yarn check:no-upstream-copy [--root <dir>] [--upstream <git-dir>] [--pin <file>]` (M1-AC4, ADR-0009).
// Returns the process exit code.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Output } from './checkPin.ts';
import { readPinFile } from './pin.ts';
import { pinRelativePath } from './repoRoot.ts';
import { defaultCacheDir, ensureUpstreamTree, findCopies, minimumSize, upstreamBlobIndex } from './upstreamCopy.ts';

const usage = 'usage: check:no-upstream-copy [--root <dir>] [--upstream <git-dir>] [--pin <file>]';

export const runCheckNoUpstreamCopy = (argv: string[], repoRoot: string, out: Output, cacheDir = defaultCacheDir()): number => {
	let root: string;
	let upstreamDir: string | null;
	let pinPath: string;
	try {
		const { values } = parseArgs({
			args: argv,
			options: { root: { type: 'string' }, upstream: { type: 'string' }, pin: { type: 'string' } },
			strict: true,
			allowPositionals: false,
		});
		root = resolve(values.root ?? repoRoot);
		upstreamDir = values.upstream === undefined ? null : resolve(values.upstream);
		// The pin always comes from this repository unless given explicitly; --root only selects the scanned tree.
		pinPath = resolve(values.pin ?? join(repoRoot, pinRelativePath));
	} catch (error) {
		out.error(`check:no-upstream-copy: ${(error as Error).message}`);
		out.error(usage);
		return 2;
	}

	const { pin, problems } = readPinFile(pinPath);
	if (!pin) {
		out.error(`check:no-upstream-copy: ${pinPath} is not a valid upstream pin; run \`corepack yarn check:pin\`:`);
		for (const problem of problems) out.error(`  - ${problem}`);
		return 1;
	}

	try {
		const tree = ensureUpstreamTree(pin.web.repo, pin.web.commit, upstreamDir, cacheDir);
		if (tree.fetched) out.info(`check:no-upstream-copy: fetched the upstream tree at ${pin.web.commit} (blobless) into ${tree.gitDir}`);
		const index = upstreamBlobIndex(tree.gitDir, pin.web.commit);
		const { scanned, copies } = findCopies(root, index);
		if (copies.length > 0) {
			out.error(`check:no-upstream-copy: ${copies.length} tracked file(s) in ${root} are verbatim copies of upstream files at ${pin.web.tag} (${pin.web.commit}):`);
			for (const copy of copies) out.error(`  - ${copy.path} is byte-identical to upstream:${copy.upstreamPaths.join(', upstream:')}`);
			out.error('Consume upstream through its published interfaces instead, or move a required change to patches/ (CLAUDE.md, ADR-0009).');
			return 1;
		}
		out.info(`check:no-upstream-copy: OK. ${scanned} tracked file(s) of at least ${minimumSize} bytes in ${root}; none matches the ${index.size} upstream blobs at ${pin.web.tag} (${pin.web.commit}).`);
		return 0;
	} catch (error) {
		out.error(`check:no-upstream-copy: ${(error as Error).message}`);
		return 1;
	}
};
