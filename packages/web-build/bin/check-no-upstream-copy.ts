// Entry point for `corepack yarn check:no-upstream-copy`. Run by Node's built-in type stripping (no build step).
import { runCheckNoUpstreamCopy } from '../src/checkNoUpstreamCopy.ts';
import { findRepoRoot } from '../src/repoRoot.ts';

process.exitCode = runCheckNoUpstreamCopy(process.argv.slice(2), findRepoRoot(import.meta.dirname), {
	info: line => process.stdout.write(`${line}\n`),
	error: line => process.stderr.write(`${line}\n`),
});
