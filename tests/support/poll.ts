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
