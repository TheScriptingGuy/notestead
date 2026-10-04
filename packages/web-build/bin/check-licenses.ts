// Entry point for `corepack yarn check:licenses`. Run by Node's built-in type stripping (no build step).
import { runCheckLicenses } from '../src/checkLicenses.ts';
import { findRepoRoot } from '../src/repoRoot.ts';

process.exitCode = runCheckLicenses(process.argv.slice(2), findRepoRoot(import.meta.dirname), {
	info: line => process.stdout.write(`${line}\n`),
	error: line => process.stderr.write(`${line}\n`),
});
