// Leaving a trashed note (tests/e2e/support/trashExit.ts; docs/test-plans/CI-M2-S2-x64-arm64.md, finding E): after "Delete"
// upstream either stays on the note screen or leaves it by itself; the page object accepts both, with a bound.
import { describe, expect, test } from '@jest/globals';
import { afterStayed, stayedAfterMs, trashExit } from '../../e2e/support/trashExit.ts';

describe('trash exit', () => {
	test('trash-01 the list is showing: the app left by itself, at any time', () => {
		expect(trashExit({ onList: true, onNote: false, backVisible: false, msSinceDelete: 0 })).toBe('left');
		expect(trashExit({ onList: true, onNote: false, backVisible: false, msSinceDelete: 10_000 })).toBe('left');
	});

	test('trash-02 still on the note with Back visible after the settle time: it stayed', () => {
		expect(trashExit({ onList: false, onNote: true, backVisible: true, msSinceDelete: stayedAfterMs })).toBe('stayed');
		expect(stayedAfterMs).toBe(3_000);
	});

	test('trash-03 the same just before the settle time: undecided, upstream may still leave', () => {
		expect(trashExit({ onList: false, onNote: true, backVisible: true, msSinceDelete: 2_999 })).toBeUndefined();
	});

	test('trash-04 a screen in transition is undecided', () => {
		expect(trashExit({ onList: false, onNote: false, backVisible: false, msSinceDelete: 10_000 })).toBeUndefined();
	});

	test('trash-05 on the note without a Back button is undecided', () => {
		expect(trashExit({ onList: false, onNote: true, backVisible: false, msSinceDelete: 10_000 })).toBeUndefined();
	});

	// CI-M2-S2 r2 C1: after `stayed`, the Back click can race with upstream leaving the trashed note by itself.
	const list = { onList: true, onNote: false, backVisible: false, msSinceDelete: 10_000 };
	const note = { onList: false, onNote: true, backVisible: true, msSinceDelete: 10_000 };
	const neither = { onList: false, onNote: false, backVisible: false, msSinceDelete: 10_000 };

	test('trash-06 after stayed, a list observation is left again', () => {
		expect(trashExit(list)).toBe('left');
	});

	test('trash-07 a Back click that raced with a late leave: detached on the list is left, a timeout on the note fails, otherwise retry', () => {
		expect(afterStayed('detached', list)).toBe('left');
		expect(afterStayed('timeout', note)).toBe('fail');
		expect(afterStayed('detached', neither)).toBe('retry');
		expect(afterStayed('done', note)).toBe('left');
		expect(afterStayed('timeout', list)).toBe('left');
		expect(afterStayed('timeout', neither)).toBe('retry');
	});
});
