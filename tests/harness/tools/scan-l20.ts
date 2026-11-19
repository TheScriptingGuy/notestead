// Reports the L20 occurrences of a run (L20 tie 2026-11-13; docs/test-plans/M2-S3.md §Brief CC-L20), read-only:
//   node tests/harness/tools/scan-l20.ts [--runner <name>] [<dir>...]        (default dir: test-results)
// Walks each directory for the `web-sqlite.json` files the harness keeps on a SQLite failure (and their attachment copies),
// prints a Markdown table per runner and the line `L20 occurrences (qualifying): N; non-qualifying SQLite failures: M`, and
// writes test-results/l20-scan.json. The runner is `--runner <name>` or the env var NOTESTEAD_RUNNER, else a
// `test-results-e2e-<runner>` folder name, else `local`; the run id is GITHUB_RUN_ID, else `local`.
// Paths with a `sens` segment (QA's sensitivity runs, which inject faults on purpose, e.g. test-results/verify/m2-s3/sens/…) are
// not scanned: an injected fault is not an occurrence (review M2-S3-r1 F2). A file that is not valid JSON is named on stderr and skipped. It never fails the job: it exits 0 unless an input directory cannot be read.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanL20 } from '../../support/l20Scan.ts';
import type { L20File } from '../../support/l20Scan.ts';

const found = function* (dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* found(path);
		else if (/web-sqlite.*\.json$/.test(entry.name) && !/(^|[/\\])sens\d*([/\\]|$)/.test(path)) yield path;
	}
};

// The console of the same attempt, for a file that predates the records: next to it, or one level up (attachments/).
const consoleFor = (path: string): string | undefined => {
	const dir = join(path, '..');
	const candidates = [join(dir, 'browser-console.log'), join(dir, '..', 'browser-console.log'), ...(existsSync(dir) ? readdirSync(dir).filter(n => /^browser-console-log-.*\.log$/.test(n)).map(n => join(dir, n)) : [])];
	const hit = candidates.find(c => existsSync(c));
	return hit ? readFileSync(hit, 'utf8') : undefined;
};

const args = process.argv.slice(2);
const flag = args.indexOf('--runner');
const flagRunner = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
const runner = flagRunner || process.env.NOTESTEAD_RUNNER || undefined;
const dirs = args;
if (dirs.length === 0) dirs.push('test-results');
const files: L20File[] = [];
try {
	for (const dir of dirs) for (const path of found(dir)) files.push({ path, text: readFileSync(path, 'utf8'), consoleText: consoleFor(path) });
} catch (error) {
	process.stderr.write(`scan-l20: cannot read the input: ${(error as Error).message}\n`);
	process.exit(1);
}
const scan = scanL20(files, { runner });
for (const path of scan.skipped) process.stderr.write(`scan-l20: skipped ${path}: not valid JSON\n`);
const runId = process.env.GITHUB_RUN_ID ?? 'local';
const runners = [...new Set(scan.occurrences.map(o => o.runner))].sort();
for (const runner of runners) {
	process.stdout.write(`\n### L20 occurrences, runner ${runner}\n\n| run id | runner | test | attempt | rc | statement | db | startup failed | qualifies | evidence |\n|---|---|---|---|---|---|---|---|---|---|\n`);
	for (const o of scan.occurrences.filter(x => x.runner === runner)) {
		process.stdout.write(`| ${runId} | ${o.runner} | ${o.test} | ${o.attempt} | ${o.rc === null ? 'n/a' : o.rc} | ${o.statement} | ${o.db} | ${o.startupFailed ? 'yes' : 'no'} | ${o.qualifies ? 'yes' : 'no'} | ${o.path} |\n`);
	}
}
process.stdout.write(`\nL20 occurrences (qualifying): ${scan.qualifying}; non-qualifying SQLite failures: ${scan.nonQualifying}\n`);
mkdirSync('test-results', { recursive: true });
writeFileSync(join('test-results', 'l20-scan.json'), `${JSON.stringify({ runId, ...scan }, null, 2)}\n`);
