// When to press the web app's Synchronise button again (tests/e2e/support/syncPress.ts). The app starts a sync of its own
// about two seconds after an edit; a press that lands just after it starts finds the button already reading "Cancel", and
// cancels that sync (observed in the first local run under the CI locale: "Sync: starting" at 03:24:31.871, "Sync:
// cancelling" at 03:24:32.062, then no delta request for the 3 minutes of syncWebOnce's poll; docs/test-plans/CI-M2-S2-x64-arm64.md).
// The press has then produced no sync, so it is made again, a bounded number of times.
import { describe, expect, test } from '@jest/globals';
import { maxPresses, pressAgain, pressSettleMs, syncProbe } from '../../e2e/support/syncPress.ts';

const lost = { deltaSeen: false, idle: true, msSincePress: pressSettleMs + 500, presses: 1 };

describe('web sync press', () => {
	test('press-01 presses again when the button is idle again, with no delta request since the press', () => {
		expect(pressAgain(lost)).toBe(true);
		expect(pressAgain({ ...lost, presses: maxPresses - 1 })).toBe(true);
	});

	test('press-02 never presses while the sync may still be coming or running', () => {
		// a delta request was seen: the sync ran
		expect(pressAgain({ ...lost, deltaSeen: true })).toBe(false);
		// the button reads Cancel: a sync is running
		expect(pressAgain({ ...lost, idle: false })).toBe(false);
		// the press is too young: the sync may not have started yet
		expect(pressAgain({ ...lost, msSincePress: pressSettleMs - 1 })).toBe(false);
	});

	test('press-03 gives up after the allowed number of presses, so the poll reports the failure', () => {
		expect(maxPresses).toBeGreaterThanOrEqual(2);
		expect(maxPresses).toBeLessThanOrEqual(4);
		expect(pressAgain({ ...lost, presses: maxPresses })).toBe(false);
	});

	// The poll body of syncWebOnce, with its dependencies faked (review CI-M2-S2-r1 C5).
	const deps = (o: { delta?: boolean; idle?: boolean; report?: string; now: () => number }) => {
		const calls = { press: 0, mark: 0 };
		return { calls, d: { deltaSinceMark: () => o.delta ?? false, idle: async () => o.idle ?? true, press: async () => { calls.press++; }, setMark: () => { calls.mark++; }, report: async () => o.report ?? '', now: o.now } };
	};
	const fresh = () => ({ presses: 1, pressedAt: 0, report: '' });

	describe('sync probe', () => {
		test('press-04 completion: a delta since the mark, an idle button and a Completed report', async () => {
			const state = fresh();
			const { calls, d } = deps({ delta: true, report: 'Completed: 25/10/2026 10:00', now: () => pressSettleMs });
			expect(await syncProbe(state, d)).toBe('completed');
			expect(state.report).toBe('Completed: 25/10/2026 10:00');
			expect(calls.press).toBe(0);
		});

		test('press-05 a lost press is made again once, and the clock restarts at it', async () => {
			const state = fresh();
			const first = deps({ now: () => pressSettleMs });
			expect(await syncProbe(state, first.d)).toMatch(/^pressed again \(press 2\)/);
			expect(first.calls.press).toBe(1);
			expect(first.calls.mark).toBe(1);
			expect(state.presses).toBe(2);
			expect(state.pressedAt).toBe(pressSettleMs);
			// one second later, still no delta: the clock restarted at the re-press, so nothing is pressed
			const second = deps({ now: () => pressSettleMs + 1000 });
			expect(await syncProbe(state, second.d)).toBe('no delta request since the press');
			expect(second.calls.press).toBe(0);
			expect(first.calls.press).toBe(1);
		});

		test('press-06 never more than maxPresses', async () => {
			const state = { presses: maxPresses, pressedAt: 0, report: '' };
			const { calls, d } = deps({ now: () => 10 * pressSettleMs });
			expect(await syncProbe(state, d)).toBe('no delta request since the press');
			expect(calls.press).toBe(0);
		});

		test('press-07 a running sync', async () => {
			const { d } = deps({ delta: true, idle: false, now: () => pressSettleMs });
			expect(await syncProbe(fresh(), d)).toBe('a sync is running');
		});

		test('press-08 an error or no report yet', async () => {
			const error = deps({ delta: true, report: 'Last error: boom', now: () => pressSettleMs });
			expect(await syncProbe(fresh(), error.d)).toMatch(/^the sync reported an error: /);
			const early = deps({ delta: true, report: 'Created local items: 1', now: () => pressSettleMs });
			expect(await syncProbe(fresh(), early.d)).toMatch(/^no completed report yet: /);
		});
	});
});
