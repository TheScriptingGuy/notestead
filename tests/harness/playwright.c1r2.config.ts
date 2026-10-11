// Playwright config for the C1-R2 killed-run proof (M1-S8; docs/test-plans/M1-S8.md §C1-R2). Run only by
// tests/integration/harness/c1r2-killed-run.test.ts, with NST_C1R2_OUT set. No stack and no browser: the inner spec
// writes a trace-like zip and an output file holding a registered secret, so the redacting reporter has something to
// redact, and the outer test either lets the run finish or kills it before the reporter could.
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const out = process.env.NST_C1R2_OUT;
if (!out) throw new Error('tests/harness/playwright.c1r2.config.ts is run by tests/integration/harness/c1r2-killed-run.test.ts only (NST_C1R2_OUT is not set)');

export default defineConfig({
	testDir: 'c1r2',
	testMatch: /\.spec\.ts$/,
	outputDir: join(out, 'output'),
	forbidOnly: true,
	workers: 1,
	retries: 0,
	timeout: 3 * 60_000,
	reporter: [
		['../e2e/support/redactingReporter.ts'],
		['list'],
		['html', { outputFolder: join(out, 'html'), open: 'never' }],
		['junit', { outputFile: join(out, 'junit.xml') }],
	],
	use: { trace: 'off', screenshot: 'off', video: 'off' },
});
