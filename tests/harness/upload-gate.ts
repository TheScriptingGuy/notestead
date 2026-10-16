// CLI of the upload gate (M1-S8 C1-R2; tests/support/uploadGate.ts, docs/test-plans/M1-S8.md §C1-R2). CI runs it after
// the test steps with `if: always()`, and uploads test-results/ and playwright-report/ only if it exited 0:
//   node tests/harness/upload-gate.ts [--root <dir>]… [--secrets-dir <dir>]… [--summary <file>]
// Defaults: --root test-results --root playwright-report; --secrets-dir <OS temp dir>; --summary
// <first root>/upload-gate.json. Exit 0: the trees are safe to upload (it prints what it removed and redacted);
// exit 1: something failed, upload nothing; exit 2: usage.
import { runUploadGate } from '../support/uploadGate.ts';

const usage = 'usage: node tests/harness/upload-gate.ts [--root <dir>]... [--secrets-dir <dir>]... [--summary <file>]';

const main = (argv: string[]): number => {
	const roots: string[] = [];
	const secretsDirs: string[] = [];
	let summaryFile: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = argv[i + 1];
		if ((arg === '--root' || arg === '--secrets-dir' || arg === '--summary') && value !== undefined) {
			if (arg === '--root') roots.push(value);
			else if (arg === '--secrets-dir') secretsDirs.push(value);
			else summaryFile = value;
			i++;
		} else {
			process.stderr.write(`upload-gate: unexpected argument ${JSON.stringify(arg)}\n${usage}\n`);
			return 2;
		}
	}
	try {
		const summary = runUploadGate({
			roots: roots.length > 0 ? roots : ['test-results', 'playwright-report'],
			...(secretsDirs.length > 0 ? { secretsDirs } : {}),
			...(summaryFile ? { summaryFile } : {}),
		});
		for (const run of summary.runs) {
			process.stdout.write(`upload-gate: ${run.dir}: ${run.complete ? 'redaction complete' : `redaction NOT complete, removed ${run.removed.join(', ') || 'nothing'}`}\n`);
		}
		for (const file of summary.redacted) process.stdout.write(`upload-gate: redacted ${file}\n`);
		process.stdout.write(`upload-gate: OK (${summary.filesRedacted} file(s) redacted, ${summary.filesRemoved} removed, ${summary.plantedRemoved} planted.json removed, ${summary.artifactDirsRemoved} raw trace dir(s) removed, ${summary.registries} leftover registr(y/ies) used)\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`upload-gate: FAILED, upload nothing: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
};

process.exitCode = main(process.argv.slice(2));
