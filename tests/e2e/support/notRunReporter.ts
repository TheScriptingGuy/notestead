// "Not run" counts as failed (docs/test-plans/M2-S5.md D9; M2-S1 r1 C3). When a project's dependency fails, Playwright does not run the
// dependent project's tests and reports them only as "did not run"; the suite has no skips by rule, and @network tests are filtered
// out before the run, so every test without a result, and every test whose last result is skipped or interrupted, did not run. This
// reporter lists them by name, writes `not-run.json` ({ count, tests }) and fails the run. Listed after the redacting reporter in
// playwright.config.ts. Titles are test titles, never data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { notRunTests } from './notRun.ts';
import type { RunEntry } from './notRun.ts';

export default class NotRunReporter implements Reporter {
	private suite: Suite | undefined;
	private readonly outputFile: string;

	public constructor(options: { outputFile?: string } = {}) {
		this.outputFile = resolve(options.outputFile ?? `${findRepoRoot()}/test-results/e2e/not-run.json`);
	}

	public onBegin(_config: FullConfig, suite: Suite): void {
		this.suite = suite;
	}

	public onEnd(_result: FullResult): Promise<{ status: 'failed' } | undefined> {
		const entries: RunEntry[] = (this.suite?.allTests() ?? []).map(t => ({
			project: t.parent.project()?.name ?? '',
			file: t.location.file.replace(`${findRepoRoot()}/`, ''),
			title: t.title,
			// a test without a result never started
			status: t.results.at(-1)?.status ?? 'skipped',
		}));
		const { count, tests } = notRunTests(entries);
		mkdirSync(dirname(this.outputFile), { recursive: true });
		writeFileSync(this.outputFile, `${JSON.stringify({ count, tests }, null, '\t')}\n`);
		if (count === 0) return Promise.resolve(undefined);
		const lines = [`NOT RUN (counts as failed): ${count} test(s)`, ...tests.map(t => `  ${t.project} › ${t.file} › ${t.title} (${t.status})`)];
		process.stdout.write(`${lines.join('\n')}\n`);
		return Promise.resolve({ status: 'failed' });
	}

	public printsToStdio(): boolean {
		return false;
	}
}
