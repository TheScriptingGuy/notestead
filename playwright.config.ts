// Playwright for the E2E layer (ADR-0007/0009). Tests live in tests/e2e (QA-owned); the harness fixtures, web
// server wiring and log attachments arrive with M1-S6. Locally (the Pi) one worker, as the resource rules require.
import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;

export default defineConfig({
	testDir: 'tests/e2e',
	outputDir: 'test-results/e2e',
	forbidOnly: true,
	workers: ci ? undefined : 1,
	retries: ci ? 1 : 0,
	reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
	use: {
		trace: 'retain-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
	],
});
