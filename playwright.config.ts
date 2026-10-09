// Playwright for the E2E layer (ADR-0007/0009; docs/test-plans/M1-S6.md §Playwright harness). QA-owned.
// - Tests: tests/e2e/**/*.spec.ts, using the fixtures of tests/e2e/support/fixtures.ts.
// - globalSetup: the real-server guard (M1-AC19), then the compose test stack (tests/stack) up and healthy before any
//   test runs (M1-AC18); its teardown removes everything the run created.
// - Workers: 1 locally (the Pi's one-heavy-job rule); CI decides. Retries: 0 locally, 1 in CI (flake policy,
//   docs/testing/strategy.md §6).
// - Reports: the redacting reporter first (it redacts every attachment, the trace included, before anything copies
//   it), then list (console), HTML (playwright-report/) and JUnit (test-results/e2e/junit.xml) for CI.
// - Browser: tests/e2e/support/chromium.ts (the installed Chromium locally when Playwright's revision is missing).
import { defineConfig, devices } from '@playwright/test';
import { chooseChromium } from './tests/e2e/support/chromium.ts';

const ci = !!process.env.CI;
const chromium = chooseChromium();

export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: '**/*.spec.ts',
	outputDir: 'test-results/e2e/output',
	forbidOnly: true,
	workers: ci ? undefined : 1,
	retries: ci ? 1 : 0,
	// A test may start its own headless service (an initial E2EE sync: ~1 min on the Pi).
	timeout: 10 * 60_000,
	globalSetup: './tests/e2e/support/globalSetup.ts',
	reporter: [
		['./tests/e2e/support/redactingReporter.ts'],
		['list'],
		['html', { outputFolder: 'playwright-report', open: 'never' }],
		['junit', { outputFile: 'test-results/e2e/junit.xml' }],
	],
	use: {
		trace: 'retain-on-failure',
		screenshot: 'off',
		video: 'off',
		launchOptions: chromium.executablePath ? { executablePath: chromium.executablePath } : {},
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
	],
});
