// When a restarted headless service counts as ready (tests/stack/restartReady.ts; docs/test-plans/CI-M2-S2-x64-arm64.md,
// finding F): the supervisor's own /healthz says 200 with a lastSync strictly after the restart. Podman's health status is
// only used to fail fast: on the CI runners it can still read "starting" long after the service was ready.
import { describe, expect, test } from '@jest/globals';
import { restartVerdict, startVerdict } from '../../stack/restartReady.ts';

const t0 = Date.UTC(2026, 9, 23, 11, 43, 32);
const at = (ms: number): string => new Date(t0 + ms).toISOString();

describe('restart readiness', () => {
	test('restart-01 ready on /healthz with a fresh sync, although podman still says starting', () => {
		expect(restartVerdict({ running: true, health: 'starting', healthz: { status: 200, lastSync: at(3_800) }, startedMs: t0 })).toBe('done');
	});

	test('restart-02 a sync equal to the restart time is not fresh', () => {
		expect(restartVerdict({ running: true, health: 'healthy', healthz: { status: 200, lastSync: at(0) }, startedMs: t0 })).toBe('wait');
		expect(restartVerdict({ running: true, health: 'healthy', healthz: { status: 200, lastSync: at(-1_000) }, startedMs: t0 })).toBe('wait');
	});

	test('restart-03 /healthz not answering yet (the exec failed): wait', () => {
		expect(restartVerdict({ running: true, health: 'healthy', healthz: undefined, startedMs: t0 })).toBe('wait');
	});

	test('restart-04 a container that is not running fails, naming exited', () => {
		const v = restartVerdict({ running: false, health: 'exited', healthz: undefined, startedMs: t0 });
		expect(typeof v === 'object' && v.fail).toMatch(/exited/);
	});

	test('restart-05 unhealthy with /healthz not ready fails', () => {
		const v = restartVerdict({ running: true, health: 'unhealthy', healthz: undefined, startedMs: t0 });
		expect(typeof v === 'object' && v.fail).toMatch(/unhealthy/);
	});

	test('restart-06 a 503 with a fresh sync is not ready: wait', () => {
		expect(restartVerdict({ running: true, health: 'starting', healthz: { status: 503, lastSync: at(3_800) }, startedMs: t0 })).toBe('wait');
	});

	// A fresh per-test headless service (CI-M2-S2 G): ready is the same /healthz, without a "fresh sync" test (there was no
	// earlier sync). Podman's health status only fails fast.
	describe('fresh start readiness', () => {
		test('start-01 compose exited 0, running, podman still says starting, /healthz 200: done', () => {
			expect(startVerdict({ composeExit: 0, running: true, health: 'starting', healthz: { status: 200 } })).toBe('done');
		});

		test('start-02 healthy but /healthz not answering: wait', () => {
			expect(startVerdict({ composeExit: 0, running: true, health: 'healthy', healthz: undefined })).toBe('wait');
		});

		test('start-03 a compose exit other than 0 fails, naming the exit code', () => {
			const v = startVerdict({ composeExit: 125, running: true, health: 'starting', healthz: undefined });
			expect(typeof v === 'object' && v.fail).toMatch(/125/);
		});

		test('start-04 not running, or unhealthy with /healthz not 200, fails', () => {
			expect(typeof startVerdict({ composeExit: 0, running: false, health: 'exited', healthz: undefined })).toBe('object');
			expect(typeof startVerdict({ composeExit: 0, running: true, health: 'unhealthy', healthz: { status: 503 } })).toBe('object');
		});
	});
});
