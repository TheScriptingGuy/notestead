// Playwright config for the C-N3 proof (M2-S1; review M1-S7-r1 C-N3, docs/test-plans/M2-S1.md): a spec that asks for
// Playwright's built-in `page` or `context` fixture fails and is pointed to `webApp`. Run only by
// tests/integration/harness/cn3-builtin-fixtures.test.ts, with NST_CN3_OUT set. No stack and no browser launch for
// the failing tests: the outer test hands the worker a fake stack descriptor.
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { chooseChromium } from '../e2e/support/chromium.ts';

const out = process.env.NST_CN3_OUT;
if (!out) throw new Error('tests/harness/playwright.cn3.config.ts is run by tests/integration/harness/cn3-builtin-fixtures.test.ts only (NST_CN3_OUT is not set)');

const chromium = chooseChromium();

export default defineConfig({
	testDir: 'cn3',
	testMatch: /\.spec\.ts$/,
	outputDir: join(out, 'output'),
	forbidOnly: true,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [
		['list'],
		['json', { outputFile: join(out, 'report.json') }],
	],
	use: {
		trace: 'off',
		screenshot: 'off',
		video: 'off',
		launchOptions: chromium.executablePath ? { executablePath: chromium.executablePath } : {},
	},
});
