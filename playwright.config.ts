// Playwright for the E2E layer (ADR-0007/0009; docs/test-plans/M1-S6.md §Playwright harness). QA-owned.
// - Tests: tests/e2e/**/*.spec.ts, using the fixtures of tests/e2e/support/fixtures.ts.
// - globalSetup: the real-server guard (M1-AC19), then the compose test stack (tests/stack) up and healthy before any
//   test runs (M1-AC18); its teardown removes everything the run created.
// - Bounds: actions 60 s, navigations 120 s, the CI run 40 min (tests/e2e/support/timeouts.ts; CI-T-01…04).
// - Workers: 1 locally (the Pi's one-heavy-job rule); CI decides. Retries: 0 locally, 1 in CI (flake policy,
//   docs/testing/strategy.md §6).
// - Reports: the redacting reporter first (it redacts every attachment, the trace included, before anything copies
//   it), then list (console), HTML (playwright-report/) and JUnit (test-results/e2e/junit.xml) for CI.
// - Traces: recorded by the `webApp` fixture (no screenshots) and kept on failure; see `use.trace` below.
// - Projects: `chromium` (parallel) and `chromium-serial` (*.serial.spec.ts: specs that disrupt a shared service, one
//   worker, after `chromium`; tests/e2e/support/projects.ts, ADR-0007 A3).
// - Browser: tests/e2e/support/chromium.ts (the installed Chromium locally when Playwright's revision is missing),
//   and the browser process's locale environment (en-GB, whatever the host's locale is).
import { defineConfig, devices } from '@playwright/test';
import { browserLocaleEnv, chooseChromium } from './tests/e2e/support/chromium.ts';
import { e2eProjects } from './tests/e2e/support/projects.ts';
import { actionTimeoutMs, ciGlobalTimeoutMs, navigationTimeoutMs } from './tests/e2e/support/timeouts.ts';

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
	// The CI run ends itself 5 minutes before the 45-minute step, so the reporters finish and the upload gate keeps the
	// traces; locally there is no limit (tests/e2e/support/timeouts.ts, docs/test-plans/CI-M2-S2-x64-arm64.md Decisions B).
	globalTimeout: ci ? ciGlobalTimeoutMs : 0,
	globalSetup: './tests/e2e/support/globalSetup.ts',
	reporter: [
		['./tests/e2e/support/redactingReporter.ts'],
		['list'],
		['html', { outputFolder: 'playwright-report', open: 'never' }],
		['junit', { outputFile: 'test-results/e2e/junit.xml' }],
	],
	use: {
		// Off on purpose: the `webApp` fixture records its context's trace itself and attaches it on failure, without
		// screenshots (docs/test-plans/M1-S7.md, Finding F2: Playwright's own trace merge hangs on Node 24 for the real
		// app's traces; screencast frames cannot be redacted).
		// No Playwright action or navigation waits forever: a stuck click fails in a minute and names its locator.
		actionTimeout: actionTimeoutMs,
		navigationTimeout: navigationTimeoutMs,
		trace: 'off',
		screenshot: 'off',
		video: 'off',
		// The browser process runs in the contexts' locale (en-GB): Chromium lays out date fields by the process locale, not by
		// the context's (docs/test-plans/CI-M2-S2-x64-arm64.md Decisions A).
		launchOptions: { ...(chromium.executablePath ? { executablePath: chromium.executablePath } : {}), env: browserLocaleEnv(process.env) },
	},
	projects: e2eProjects(devices['Desktop Chrome']),
});
