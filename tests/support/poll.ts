// The one polling primitive of the harness (ADR-0007: wait for conditions, never for fixed times). Every wait in
// Jest, Playwright fixtures and harness code goes through `waitFor`, or Playwright's own `expect.poll`. The interval
// between probes is the only timer the test code may use (docs/test-plans/M1-S6.md, lint follow-up F1), which is why
// it lives here and nowhere else. Shared by Jest (CommonJS through ts-jest) and Playwright/Node (ESM): no __dirname,
// no import.meta.
import { setTimeout as pause } from 'node:timers/promises';

export interface WaitOptions {
	timeoutMs?: number;
	intervalMs?: number;
	// Called after every unsuccessful probe; a returned message aborts the wait at once (for example: the container
	// being waited on has exited).
	failFast?: () => string | undefined;
}

export const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>, opts: WaitOptions = {}): Promise<T> => {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const deadline = Date.now() + timeoutMs;
	let last: unknown = null;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined) return value;
		} catch (error) {
			last = error;
		}
		const fatal = opts.failFast?.();
		if (fatal) throw new Error(`while waiting for ${what}: ${fatal}`);
		await pause(opts.intervalMs ?? 250);
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `; last error: ${String(last)}` : ''}`);
};

// "X never happens" over a bounded window anchored to an observed event (docs/testing/strategy.md §3, "Absence over a
// window"): probes until `windowMs` has passed and fails at the first probe that returns a violation message. A probe
// that throws fails too: an absence that could not be observed is not proven. Returns the number of probes made.
export const holdsFor = async (what: string, probe: () => Promise<string | undefined>, opts: { windowMs: number; intervalMs?: number }): Promise<number> => {
	const deadline = Date.now() + opts.windowMs;
	let probes = 0;
	for (;;) {
		const violation = await probe();
		probes++;
		if (violation !== undefined) throw new Error(`${what} did not hold: ${violation} (after ${probes} probes)`);
		if (Date.now() >= deadline) return probes;
		await pause(opts.intervalMs ?? 1_000);
	}
};
