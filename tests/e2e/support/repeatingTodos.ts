// The user's repeating-todos plugin, pinned at 2.1.2 (tests/fixtures/plugins/repeating-todos/provenance.json), and the
// recurrence seed (docs/test-plans/M2-S4.md P6). The seed format is coupled to the plugin's RecurrenceData at 2.1.2
// (plugin src/model/recurrence.ts:51-68, :82-97): a fixture bump updates the unit test rec-02 on purpose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../support/repoRoot.ts';

export interface RepeatingTodosFixture { path: string; id: string; name: string; version: string; sha256: string; size: number }

const directory = (): string => join(findRepoRoot(), 'tests', 'fixtures', 'plugins', 'repeating-todos');

export const repeatingTodosFixture = (): RepeatingTodosFixture => {
	const p = JSON.parse(readFileSync(join(directory(), 'provenance.json'), 'utf8')) as Record<string, string | number>;
	return { path: join(directory(), String(p.file)), id: String(p.id), name: String(p.name), version: String(p.version), sha256: String(p.sha256), size: Number(p.size) };
};

export const recurrenceKey = 'recurrence';

export const repeatingTodoUserData = (r: { interval: 'day' }, nowMs: number): string => {
	const v = {
		enabled: true, interval: r.interval, intervalNumber: 1, weekSunday: false, weekMonday: false, weekTuesday: false,
		weekWednesday: false, weekThursday: false, weekFriday: false, weekSaturday: false, monthOrdinal: 'first',
		monthWeekday: '', stopType: 'never', stopDate: null, stopNumber: 1, resetAlarmWhenNotDone: false,
	};
	return JSON.stringify({ [repeatingTodosFixture().id]: { [recurrenceKey]: { v, t: nowMs } } });
};

export const recurrenceOf = (userData: string): Record<string, unknown> | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(userData);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const ns = (parsed as Record<string, unknown>)[repeatingTodosFixture().id];
	if (typeof ns !== 'object' || ns === null) return undefined;
	const entry = (ns as Record<string, unknown>)[recurrenceKey];
	if (typeof entry !== 'object' || entry === null) return undefined;
	const v = (entry as Record<string, unknown>).v;
	return typeof v === 'object' && v !== null ? v as Record<string, unknown> : undefined;
};

// The plugin's own label strings (plugin src/core/commands.ts, src/gui/menu.ts at 2.1.2).
export const pluginMenuLabels = ['Repeating Todos', 'Update All Recurrence Information', 'Update Overdue To-Dos', 'Reschedule Overdue To-Dos to Today'] as const;
export const pluginNoteToolbarLabel = 'Open Recurrence Dialog';
export const recurringTagTitle = 'recurring';
