// Writes a Markdown summary of the e2e.yml results for $GITHUB_STEP_SUMMARY (M1-S8, CI evidence X2 and X3): the Jest
// JSON of the contract layer (totals, and the status of each test file) and the totals of the Playwright JUnit file.
// Usage: node .github/scripts/e2e-summary.ts <title> --jest <jest.json> --junit <junit.xml>
// e2e.yml runs it only after the upload gate succeeded, so it reads redacted files. It prints counts, file paths and
// the names of failed tests, never a failure message. It never fails the job: the test steps do that.
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

interface JestAssertion {
	status: string;
	fullName?: string;
}

interface JestFile {
	name: string;
	status: string;
	assertionResults?: JestAssertion[];
}

interface JestJson {
	success?: boolean;
	numTotalTests?: number;
	numPassedTests?: number;
	numFailedTests?: number;
	numPendingTests?: number;
	numTodoTests?: number;
	numFailedTestSuites?: number;
	numRuntimeErrorTestSuites?: number;
	testResults?: JestFile[];
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const jestSection = (file: string): string[] => {
	const lines = ['#### Contract layer (Jest JSON)', ''];
	if (!existsSync(file)) return [...lines, `\`${file}\` is missing: the contract step did not run, or Jest crashed before writing it.`, ''];
	let json: JestJson;
	try {
		json = JSON.parse(readFileSync(file, 'utf8')) as JestJson;
	} catch (error) {
		return [...lines, `\`${file}\` is not valid JSON (${(error as Error).message}).`, ''];
	}
	lines.push('| success | tests | passed | failed | pending | todo | failed suites | runtime errors |', '|---|---:|---:|---:|---:|---:|---:|---:|');
	lines.push(`| ${json.success} | ${json.numTotalTests} | ${json.numPassedTests} | ${json.numFailedTests} | ${json.numPendingTests} | ${json.numTodoTests} | ${json.numFailedTestSuites} | ${json.numRuntimeErrorTestSuites} |`, '');
	lines.push('| test file | status | passed | failed | other |', '|---|---|---:|---:|---:|');
	const failed: string[] = [];
	for (const result of json.testResults ?? []) {
		const assertions = result.assertionResults ?? [];
		const count = (status: string): number => assertions.filter(a => a.status === status).length;
		const other = assertions.length - count('passed') - count('failed');
		lines.push(`| ${cell(relative(process.cwd(), result.name))} | ${result.status} | ${count('passed')} | ${count('failed')} | ${other} |`);
		for (const a of assertions) if (a.status === 'failed') failed.push(a.fullName ?? '(unnamed)');
	}
	lines.push('');
	if (failed.length > 0) lines.push('Failed tests:', '', ...failed.map(name => `- ${cell(name)}`), '');
	return lines;
};

const junitSection = (file: string): string[] => {
	const lines = ['#### E2E layer (Playwright JUnit)', ''];
	if (!existsSync(file)) return [...lines, `\`${file}\` is missing: the Playwright step did not run, or it crashed before the reporters finished.`, ''];
	const xml = readFileSync(file, 'utf8');
	const root = /<testsuites\b([^>]*)>/.exec(xml)?.[1] ?? '';
	const attr = (name: string): string => new RegExp(`\\b${name}="([^"]*)"`).exec(root)?.[1] ?? '?';
	lines.push('| tests | failures | errors | skipped | time (s) |', '|---:|---:|---:|---:|---:|');
	lines.push(`| ${attr('tests')} | ${attr('failures')} | ${attr('errors')} | ${attr('skipped')} | ${attr('time')} |`, '');
	const failed = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*>(?:(?!<\/testcase>|<testcase\b)[\s\S])*?<(failure|error)\b/g)].map(m => m[1]);
	if (failed.length > 0) lines.push('Failed tests:', '', ...failed.map(name => `- ${cell(name)}`), '');
	return lines;
};

const main = (argv: string[]): number => {
	const [title, ...rest] = argv;
	let jest: string | undefined;
	let junit: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '--jest') jest = rest[++i];
		else if (rest[i] === '--junit') junit = rest[++i];
	}
	if (!title || !jest || !junit) {
		process.stderr.write('usage: node .github/scripts/e2e-summary.ts <title> --jest <jest.json> --junit <junit.xml>\n');
		return 0;
	}
	process.stdout.write([`### ${title}`, '', ...jestSection(jest), ...junitSection(junit)].join('\n'));
	return 0;
};

process.exitCode = main(process.argv.slice(2));
