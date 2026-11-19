// The pinned repeating-todos plugin fixture and the recurrence seed (docs/test-plans/M2-S4.md P6): the seed is coupled to
// the plugin's RecurrenceData at 2.1.2 (plugin src/model/recurrence.ts), so a fixture bump updates rec-02 on purpose.
import { describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recurrenceOf, repeatingTodoUserData, repeatingTodosFixture } from '../../e2e/support/repeatingTodos.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';

const provenance = (): Record<string, unknown> =>
	JSON.parse(readFileSync(join(findRepoRoot(), 'tests', 'fixtures', 'plugins', 'repeating-todos', 'provenance.json'), 'utf8')) as Record<string, unknown>;

const v = {
	enabled: true, interval: 'day', intervalNumber: 1, weekSunday: false, weekMonday: false, weekTuesday: false,
	weekWednesday: false, weekThursday: false, weekFriday: false, weekSaturday: false, monthOrdinal: 'first',
	monthWeekday: '', stopType: 'never', stopDate: null, stopNumber: 1, resetAlarmWhenNotDone: false,
};

describe('repeating-todos fixture and seed (M2-S4 P6)', () => {
	test('fix-01 the committed jpl matches provenance.json', () => {
		const p = provenance();
		const fx = repeatingTodosFixture();
		expect(fx).toEqual({ path: fx.path, id: p.id, version: p.version, sha256: p.sha256, size: p.size, name: p.name });
		expect(statSync(fx.path).size).toBe(p.size);
		expect(createHash('sha256').update(readFileSync(fx.path)).digest('hex')).toBe(p.sha256);
	});

	test('fix-02 its manifest is the pinned one', () => {
		const p = provenance();
		const fx = repeatingTodosFixture();
		const r = spawnSync('tar', ['-xOf', fx.path, 'manifest.json'], { encoding: 'utf8' });
		expect(r.status).toBe(0);
		const manifest = JSON.parse(r.stdout) as Record<string, unknown>;
		expect(manifest).toMatchObject({ id: p.id, version: p.version, name: p.name });
		expect(manifest.platforms).toContain('mobile');
	});

	test('rec-01 the user_data shape', () => {
		const fx = repeatingTodosFixture();
		expect(JSON.parse(repeatingTodoUserData({ interval: 'day' }, 1_700_000_000_000))).toEqual({ [fx.id]: { recurrence: { v, t: 1_700_000_000_000 } } });
	});

	test('rec-02 v is the plugin RecurrenceData at 2.1.2', () => {
		const parsed = JSON.parse(repeatingTodoUserData({ interval: 'day' }, 1)) as Record<string, { recurrence: { v: unknown } }>;
		expect(parsed[repeatingTodosFixture().id].recurrence.v).toEqual(v);
	});

	test('rec-03 recurrenceOf', () => {
		expect(recurrenceOf(repeatingTodoUserData({ interval: 'day' }, 1))).toEqual(v);
		for (const bad of ['', '{', '{"other":{"recurrence":{"v":{},"t":1}}}', 'null']) expect(recurrenceOf(bad)).toBeUndefined();
	});
});
