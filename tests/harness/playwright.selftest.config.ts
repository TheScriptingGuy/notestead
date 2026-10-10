// Playwright config for the harness self-tests (docs/test-plans/M1-S6.md §Harness self-tests). These specs are run only
// by the M1-S6 contract tests (tests/contract/m1-s6/*.test.ts), each in its own Playwright process with
// NST_SELFTEST_OUT set; one of them fails on purpose (M1-AC20), so they are never part of a normal run (the main
// config's testDir is tests/e2e). Same harness as playwright.config.ts (globalSetup, fixtures, redacting reporter),
// plus a JSON report the outer test reads.
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config.ts';

const out = process.env.NST_SELFTEST_OUT;
if (!out) throw new Error('tests/harness/playwright.selftest.config.ts is run by the M1-S6 contract self-tests only (NST_SELFTEST_OUT is not set)');

export default defineConfig({
	...base,
	testDir: 'selftest',
	testMatch: /\.spec\.ts$/,
	outputDir: join(out, 'output'),
	retries: 0,
	workers: 1,
	reporter: [
		['../e2e/support/redactingReporter.ts'],
		['list'],
		['json', { outputFile: join(out, 'report.json') }],
	],
	globalSetup: '../e2e/support/globalSetup.ts',
});
