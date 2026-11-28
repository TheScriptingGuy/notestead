// H-NR-01 (docs/test-plans/M2-S5.md D9, M2-S1 r1 C3) on a real Playwright process with no browser: project `p2` depends on `p1`, so a
// failing `p1` leaves `p2`'s test not run. The not-run reporter must say so by name, write not-run.json and fail the run. NEG: the
// same configuration with a passing `p1` runs `p2`, reports 0 and passes.
// The throwaway config and specs live under test-results/ (gitignored), not in the system temp dir: a spec outside the repository
// cannot resolve `@playwright/test`.
import { afterEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../support/repoRoot.ts';

const repoRoot = findRepoRoot();
const temps: string[] = [];

const runInner = (p1Passes: boolean, extraArgs: string[] = []): { code: number | null; output: string; notRun: { count: number; tests: { project: string; file: string; title: string; status: string }[] } } => {
	mkdirSync(join(repoRoot, 'test-results'), { recursive: true });
	const dir = mkdtempSync(join(repoRoot, 'test-results', 'nst-nr-'));
	temps.push(dir);
	const outputFile = join(dir, 'not-run.json');
	writeFileSync(join(dir, 'p1.spec.ts'), `import { test, expect } from '@playwright/test';\ntest('p1 test', () => {\n\texpect(1).toBe(${p1Passes ? 1 : 2});\n});\n`);
	writeFileSync(join(dir, 'p2.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('p2 test that needs p1', () => {\n\texpect(1).toBe(1);\n});\n");
	writeFileSync(join(dir, 'playwright.config.ts'), `export default {
	testDir: ${JSON.stringify(dir)},
	outputDir: ${JSON.stringify(join(dir, 'out'))},
	reporter: [[${JSON.stringify(join(repoRoot, 'tests', 'e2e', 'support', 'notRunReporter.ts'))}, { outputFile: ${JSON.stringify(outputFile)} }], ['list']],
	projects: [
		{ name: 'p1', testMatch: 'p1.spec.ts' },
		{ name: 'p2', testMatch: 'p2.spec.ts', dependencies: ['p1'] },
	],
};
`);
	const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
	for (const key of ['CI', 'JEST_WORKER_ID', 'NODE_OPTIONS', 'NOTESTEAD_E2E_STACK']) delete env[key];
	const r = spawnSync(join(repoRoot, 'node_modules', '.bin', 'playwright'), ['test', '-c', join(dir, 'playwright.config.ts'), ...extraArgs], { cwd: repoRoot, env, encoding: 'utf8', timeout: 120_000 });
	const output = `${r.stdout}${r.stderr}`;
	if (extraArgs.includes('--list')) return { code: r.status, output, notRun: { count: existsSync(outputFile) ? -1 : 0, tests: [] } };
	if (!existsSync(outputFile)) throw new Error(`the run wrote no not-run.json (exit ${r.status}); its output ends: ${output.slice(-600)}`);
	return { code: r.status, output, notRun: JSON.parse(readFileSync(outputFile, 'utf8')) as ReturnType<typeof runInner>['notRun'] };
};

describe('H-NR-01 not-run tests fail the run', () => {
	afterEach(() => {
		for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
	});

	test('h-nr-01 a failing project leaves its dependent project\'s test not run: named, written to not-run.json, the run fails', () => {
		const r = runInner(false);
		expect(r.code).not.toBe(0);
		expect(r.output).toContain('NOT RUN (counts as failed): 1 test(s)');
		expect(r.output).toContain('p2 test that needs p1');
		expect(r.notRun.count).toBe(1);
		expect(r.notRun.tests).toHaveLength(1);
		expect(r.notRun.tests[0]).toMatchObject({ project: 'p2', title: 'p2 test that needs p1' });
	});

	test('h-nr-01-list playwright test --list runs no test, so nothing is not run: the reporter stays quiet and the exit code is 0', () => {
		const r = runInner(false, ['--list']);
		expect({ code: r.code, notRunLine: r.output.includes('NOT RUN'), wroteFile: r.notRun.count === -1 }).toEqual({ code: 0, notRunLine: false, wroteFile: false });
	});

	test('h-nr-01-neg the same configuration with a passing first project reports 0 and passes', () => {
		const r = runInner(true);
		expect({ code: r.code, tail: r.code === 0 ? '' : r.output.slice(-800) }).toEqual({ code: 0, tail: '' });
		expect(r.output).not.toContain('NOT RUN');
		expect(r.notRun).toEqual({ count: 0, tests: [] });
	});
});
