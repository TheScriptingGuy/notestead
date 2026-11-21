// The expected refusal of an older bundle (docs/test-plans/M2-S5.md F1, D6): parsing upstream's alert, and excusing the one
// startup failure it causes without excusing anything else (pr-01…04, ws-r-01…05).
import { describe, expect, test } from '@jest/globals';
import { parseProfileRefusal } from '../../e2e/support/profileRefusal.ts';
import { excusedStartupFailures } from '../../e2e/support/webSqlite.ts';
import type { SqliteFailure } from '../../e2e/support/webSqlite.ts';

// upstream:packages/lib/JoplinDatabase.ts, the sentence is the spec; the alert is root.tsx's prefix and the error.
const sentence = 'Unknown profile version. Most likely this is an old version of Joplin, while the profile was created by a newer version. Please upgrade Joplin at https://joplinapp.org and try again.';
const refusal = (profile: number | string, expected: number | string): string => `Something went wrong while starting the application: Error: ${sentence}\nJoplin version: 3.7.21\nProfile version: ${profile}\nExpected version: ${expected}`;

describe('profile refusal and the startup failures it excuses', () => {
	test('pr-01 the message gives the profile\'s and the expected version', () => {
		expect(parseProfileRefusal(refusal(54, 53))).toEqual({ profile: 54, expected: 53 });
	});

	test('pr-02 a different alert is rejected', () => {
		expect(parseProfileRefusal('Something went wrong while starting the application: Error: boom\nProfile version: 54\nExpected version: 53')).toBeUndefined();
		expect(parseProfileRefusal('')).toBeUndefined();
	});

	test('pr-03 missing or non-integer numbers are rejected', () => {
		expect(parseProfileRefusal(refusal('x', 53))).toBeUndefined();
		expect(parseProfileRefusal(refusal(54, ''))).toBeUndefined();
		expect(parseProfileRefusal(`Something went wrong while starting the application: Error: ${sentence}\nJoplin version: 3.7.21`)).toBeUndefined();
	});

	test('pr-04 the sentence must start the message', () => {
		expect(parseProfileRefusal(`alert: ${refusal(54, 53)}`)).toBeUndefined();
		expect(parseProfileRefusal(refusal(54, 53).replace('Something went wrong while starting the application: ', ''))).toBeUndefined();
	});

	const stamp = (ms: number): string => new Date(Date.parse('2026-11-21T10:00:00.000Z') + ms).toISOString();
	const startupLine = (ms: number): string => `${stamp(ms)} [error] root: Startup failure during task: buildStartupTasks/openDatabase Error: boom`;
	const startup = (line: number): SqliteFailure => ({ rc: null, kind: 'startup', statement: 'buildStartupTasks/openDatabase', line });
	const dialog = (ms: number, message = refusal(54, 53)): { message: string; ts: number } => ({ message, ts: Date.parse('2026-11-21T10:00:00.000Z') + ms });

	test('ws-r-01 a startup failure followed by a refusal dialog within 10 s is excused', () => {
		const r = excusedStartupFailures([startup(2)], ['x', startupLine(1_000)], [dialog(4_000)]);
		expect(r.excused).toEqual([startup(2)]);
		expect(r.rest).toEqual([]);
	});

	test('ws-r-02 the same dialog after 11 s, or before the failure, does not excuse it', () => {
		const late = excusedStartupFailures([startup(2)], ['x', startupLine(1_000)], [dialog(12_000)]);
		expect(late.excused).toEqual([]);
		expect(late.rest).toEqual([startup(2)]);
		expect(excusedStartupFailures([startup(2)], ['x', startupLine(5_000)], [dialog(1_000)]).rest).toEqual([startup(2)]);
		// the window is a parameter: 10 s exactly is inside, 11 s outside
		expect(excusedStartupFailures([startup(1)], [startupLine(0)], [dialog(10_000)]).excused).toHaveLength(1);
		expect(excusedStartupFailures([startup(1)], [startupLine(0)], [dialog(11_000)]).excused).toHaveLength(0);
	});

	test('ws-r-03 a step or a save failure is never excused, dialog or not', () => {
		const step: SqliteFailure = { rc: 10, kind: 'step', statement: 'INSERT notes', line: 1 };
		const save: SqliteFailure = { rc: null, kind: 'save', statement: 'settings', line: 1 };
		const r = excusedStartupFailures([step, save, startup(2)], [startupLine(0), startupLine(0)], [dialog(1_000), dialog(1_000)]);
		expect(r.excused).toEqual([startup(2)]);
		expect(r.rest).toEqual([step, save]);
	});

	test('ws-r-04 two startup failures need two dialogs: one dialog excuses one failure', () => {
		const lines = [startupLine(0), startupLine(500)];
		const one = excusedStartupFailures([startup(1), startup(2)], lines, [dialog(1_000)]);
		expect(one.excused).toEqual([startup(1)]);
		expect(one.rest).toEqual([startup(2)]);
		const two = excusedStartupFailures([startup(1), startup(2)], lines, [dialog(1_000), dialog(1_500)]);
		expect(two.excused).toHaveLength(2);
		expect(two.rest).toEqual([]);
	});

	test('ws-r-05 a dialog that is not the refusal excuses nothing, and no dialog excuses nothing', () => {
		expect(excusedStartupFailures([startup(1)], [startupLine(0)], [dialog(1_000, 'Something went wrong while starting the application: Error: boom')]).rest).toEqual([startup(1)]);
		expect(excusedStartupFailures([startup(1)], [startupLine(0)], []).rest).toEqual([startup(1)]);
		// a console line without a time stamp cannot be placed, so it is not excused
		expect(excusedStartupFailures([startup(1)], ['no time stamp here'], [dialog(1_000)]).rest).toEqual([startup(1)]);
	});
});
