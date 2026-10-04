// Writes a Markdown summary of node:test JUnit files for $GITHUB_STEP_SUMMARY (M1-S3 test plan, requirement 3):
// the totals node:test records (tests, pass, fail, cancelled, skipped, todo, duration) and the names of failed tests.
// Usage: node .github/scripts/junit-summary.ts [--outcome <step outcome>] <title> <junit.xml>...
// It never fails the job: the test step does that. A missing file is reported as such. node:test writes no JUnit
// entry for a failing before/after hook, so the step outcome is shown too: a failed step with no failed test means a
// hook or the runner failed outside any test.
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const counters = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;

const unescapeXml = (s: string): string => s
	.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
	.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
	.replace(/&amp;/g, '&');

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

export const summarize = (title: string, files: string[], outcome?: string): string => {
	const lines = [`### ${title}`, '', `| JUnit file | ${counters.join(' | ')} | duration |`, `|---|${counters.map(() => '---:|').join('')}---:|`];
	const failed: string[] = [];
	for (const file of files) {
		if (!existsSync(file)) {
			lines.push(`| ${cell(basename(file))} | missing: the suite did not run or crashed before writing JUnit |${' |'.repeat(counters.length)}`);
			continue;
		}
		const xml = readFileSync(file, 'utf8');
		const count = (name: string): string => new RegExp(`<!-- ${name} ([0-9.]+) -->`).exec(xml)?.[1] ?? '?';
		const seconds = Number(count('duration_ms')) / 1000;
		lines.push(`| ${cell(basename(file))} | ${counters.map(count).join(' | ')} | ${Number.isFinite(seconds) ? `${seconds.toFixed(1)} s` : '?'} |`);
		for (const match of xml.matchAll(/<testcase\b[^>]*>/g)) {
			if (!/\sfailure="/.test(match[0])) continue;
			const name = /\sname="([^"]*)"/.exec(match[0])?.[1] ?? '(unnamed)';
			failed.push(`${basename(file)}: ${unescapeXml(name)}`);
		}
	}
	lines.push('', failed.length === 0 ? 'Failed tests: none.' : `Failed tests (${failed.length}):`, ...failed.map(f => `- ${cell(f)}`));
	if (outcome) {
		lines.push('', `Step outcome: **${outcome}**.`);
		if (outcome === 'failure' && failed.length === 0) {
			lines.push('The step failed but JUnit records no failed test: a before/after hook or the runner failed outside any test (node:test does not write hook failures to JUnit). See the step log.');
		}
	}
	lines.push('');
	return lines.join('\n');
};

const args = process.argv.slice(2);
const outcome = args[0] === '--outcome' ? args[1] : undefined;
const [title, ...files] = outcome === undefined ? args : args.slice(2);
if (!title || files.length === 0) {
	process.stderr.write('usage: node .github/scripts/junit-summary.ts [--outcome <step outcome>] <title> <junit.xml>...\n');
	process.exitCode = 2;
} else {
	process.stdout.write(summarize(title, files, outcome));
}
