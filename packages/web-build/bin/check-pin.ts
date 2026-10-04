// Entry point for `corepack yarn check:pin`. Run by Node's built-in type stripping (no build step).
import { runCheckPin } from '../src/checkPin.ts';
import { findRepoRoot } from '../src/repoRoot.ts';

process.exitCode = runCheckPin(process.argv.slice(2), findRepoRoot(import.meta.dirname), {
	info: line => process.stdout.write(`${line}\n`),
	error: line => process.stderr.write(`${line}\n`),
});
