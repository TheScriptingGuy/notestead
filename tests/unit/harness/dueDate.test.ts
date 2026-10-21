// Due-date arithmetic for the to-do tests (tests/e2e/support/dueDate.ts; docs/test-plans/M2-S2.md D5): the wall clock of an
// epoch in a given zone is computed with Intl and an explicit timeZone, so the host's own zone never matters.
import { describe, expect, test } from '@jest/globals';
import { datetimeLocalValue, nextWholeMinute, partsIn } from '../../e2e/support/dueDate.ts';

describe('due dates', () => {
	test('due-01 the Amsterdam wall clock in summer time', () => {
		expect(partsIn(Date.UTC(2027, 6, 15, 12, 30), 'Europe/Amsterdam')).toEqual({ year: '2027', month: '07', day: '15', hour: '14', minute: '30' });
	});

	test('due-02 the Amsterdam wall clock in winter time', () => {
		expect(partsIn(Date.UTC(2026, 10, 15, 13, 30), 'Europe/Amsterdam')).toEqual({ year: '2026', month: '11', day: '15', hour: '14', minute: '30' });
	});

	test('due-03 midnight is 00, never 24', () => {
		expect(partsIn(Date.UTC(2026, 10, 14, 23, 5), 'Europe/Amsterdam')).toEqual({ year: '2026', month: '11', day: '15', hour: '00', minute: '05' });
	});

	test('due-04 nextWholeMinute rounds up to a whole minute', () => {
		expect(nextWholeMinute(Date.UTC(2026, 9, 21, 10, 0, 15), 150_000)).toBe(Date.UTC(2026, 9, 21, 10, 3));
		expect(nextWholeMinute(Date.UTC(2026, 9, 21, 10, 0, 0), 60_000)).toBe(Date.UTC(2026, 9, 21, 10, 1));
	});

	test('due-05 the datetime-local value, and the zone argument matters', () => {
		expect(datetimeLocalValue(partsIn(Date.UTC(2027, 6, 15, 12, 30), 'Europe/Amsterdam'))).toBe('2027-07-15T14:30');
		expect(partsIn(Date.UTC(2027, 6, 15, 12, 30), 'UTC').hour).toBe('12');
	});
});
