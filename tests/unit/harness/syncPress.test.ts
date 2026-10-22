// When to press the web app's Synchronise button again (tests/e2e/support/syncPress.ts). The app starts a sync of its own
// about two seconds after an edit; a press that lands just after it starts finds the button already reading "Cancel", and
// cancels that sync (observed in the first local run under the CI locale: "Sync: starting" at 03:24:31.871, "Sync:
// cancelling" at 03:24:32.062, then no delta request for the 3 minutes of syncWebOnce's poll; docs/test-plans/CI-M2-S2-x64-arm64.md).
// The press has then produced no sync, so it is made again, a bounded number of times.
import { describe, expect, test } from '@jest/globals';
import { maxPresses, pressAgain, pressSettleMs } from '../../e2e/support/syncPress.ts';

const lost = { deltaSeen: false, idle: true, msSincePress: pressSettleMs + 500, presses: 1 };

describe('web sync press', () => {
	test('press-01 presses again when the button is idle again, with no delta request since the press', () => {
		expect(pressAgain(lost)).toBe(true);
		expect(pressAgain({ ...lost, presses: maxPresses - 1 })).toBe(true);
	});

	test('press-02 never presses while the sync may still be coming or running', () => {
		expect(pressAgain({ ...lost, deltaSeen: true }), 'a delta request was seen: the sync ran').toBe(false);
		expect(pressAgain({ ...lost, idle: false }), 'the button reads Cancel: a sync is running').toBe(false);
		expect(pressAgain({ ...lost, msSincePress: pressSettleMs - 1 }), 'the sync may not have started yet').toBe(false);
	});

	test('press-03 gives up after the allowed number of presses, so the poll reports the failure', () => {
		expect(maxPresses).toBeGreaterThanOrEqual(2);
		expect(maxPresses).toBeLessThanOrEqual(4);
		expect(pressAgain({ ...lost, presses: maxPresses })).toBe(false);
	});
});
