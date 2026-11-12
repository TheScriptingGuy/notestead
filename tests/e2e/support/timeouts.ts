// The bounds of the E2E run (docs/test-plans/CI-M2-S2-x64-arm64.md Decisions B; CI run 39663284028). Playwright Test's
// default for actions and navigations is "no timeout", so a click on an element that never became actionable hung an arm64
// test for 23 minutes and the 45-minute step limit killed the run before its reporters finished. No Playwright import:
// the acceptance test CI-T-01…05 (tests/acceptance/ci-m2-s2/timeouts.test.mts) reads these constants.

// An action (click, press, waitFor without its own timeout) fails within a minute and names its locator; the Pi, the
// slowest box, does each UI action in seconds.
export const actionTimeoutMs = 60_000;

// A navigation (goto, reload) fails within two minutes; the app's first start on the Pi takes about 15 s.
export const navigationTimeoutMs = 120_000;

// The whole CI run: Playwright ends itself, its reporters finish and the upload gate keeps the traces, at least four minutes
// before the 60-minute E2E step (CC-1, WO-12; the reporters' onEnd/onExit and the upload gate run in those minutes; the global deadline also
// bounds globalTeardown, so after a global timeout the stack stays up, which is harmless on a discarded CI runner (F-B1); CI-T-02).
export const ciGlobalTimeoutMs = 55 * 60_000;

// The longest spec timeout. M2-AC7a's 100 MiB attachment (M2-S3 D7, CC-1(b), planner ruling 2026-11-12) took 15.25 min on the
// Pi, whose browser encrypts and uploads 134 MiB in 7 min; the other specs took at most 417 s. The margin is judged per box:
// in CI M2-AC7a must take at most 12.5 min (50% of this limit, since a retry is allowed: 2 x 25 < 55, CI-T-04; a slower run
// is the gate that orders a split into its own job), and on the Pi, locally and without retries, more than 20 min (80%) is
// a hard stop for the QA executor. 55 <= 60 - 4 (CI-T-02).
export const longSpecTimeoutMs = 25 * 60_000;

// A per-test headless service gives up this long after its start (CI-M2-S2 G, CI run 39957733152): at least two minutes
// before the 10-minute test timeout, so the fixture's own failure, with the supervisor's log, is reported instead of
// "Test timeout exceeded while setting up headlessService". A fresh service is ready in under 1.5 minutes on every runner;
// 7 minutes also cover about ten of the supervisor's 30 s initial-cycle retries (CI-T-05).
export const headlessUpTimeoutMs = 7 * 60_000;
