// Where upstream puts the focus on a new note or to-do, and when it has stayed there (tests/e2e/support/settle.ts; review
// M2-S2-r1 C1, docs/test-plans/M2-S3.md D8 and F5).
import { describe, expect, test } from '@jest/globals';
import { focusTargetFor, settleTracker } from '../../e2e/support/settle.ts';

describe('settle', () => {
	test('settle-01 upstream\'s focus target', () => {
		expect(focusTargetFor('note')).toBe('editor');
		expect(focusTargetFor('todo')).toBe('title');
	});

	test('settle-02 settled at the n-th consecutive reading of the target', () => {
		const seen = settleTracker('editor', 3);
		expect([seen('editor'), seen('editor'), seen('editor')]).toEqual([false, false, true]);
	});

	test('settle-03 any other reading resets the count', () => {
		const seen = settleTracker('editor', 3);
		expect([seen('editor'), seen('editor'), seen('title')]).toEqual([false, false, false]);
		expect([seen('editor'), seen('editor'), seen('editor')]).toEqual([false, false, true]);
		expect(() => settleTracker('x', 0)).toThrow(/at least one poll/);
	});
});
