// The bounds of the E2E run (docs/test-plans/CI-M2-S2-x64-arm64.md Decisions B; CI run 39663284028). Playwright Test's
// default for actions and navigations is "no timeout", so a click on an element that never became actionable hung an arm64
// test for 23 minutes and the 45-minute step limit killed the run before its reporters finished. No Playwright import:
// the acceptance test CI-T-01…04 (tests/acceptance/ci-m2-s2/timeouts.test.mts) reads these constants.

// An action (click, press, waitFor without its own timeout) fails within a minute and names its locator; the Pi, the
// slowest box, does each UI action in seconds.
export const actionTimeoutMs = 60_000;

// A navigation (goto, reload) fails within two minutes; the app's first start on the Pi takes about 15 s.
export const navigationTimeoutMs = 120_000;

// The whole CI run: Playwright ends itself, its reporters finish and the upload gate keeps the traces, at least four minutes
// before the 45-minute E2E step (globalTeardown removes the stack and onEnd writes the reports in those minutes; CI-T-02).
export const ciGlobalTimeoutMs = 40 * 60_000;

// The longest spec timeout (the M2-S2 specs: five headless restarts at up to 90 s each on x64, plus the NEG window); the
// slowest took 417 s on the Pi. A test plus its CI retry (2 x 15 min) must fit inside ciGlobalTimeoutMs (CI-T-04).
export const longSpecTimeoutMs = 15 * 60_000;
