// Data snapshots of the account through the Data API and their comparison (docs/test-plans/M2-S5.md D8, sn-01…05). Failure
// messages carry ids and field names only, never a title or a body (review M2-S2-r1 C4).
import { describe, expect, test } from '@jest/globals';
import { compareSnapshots, snapshotProblems } from '../../e2e/support/snapshot.ts';
import type { Snapshot } from '../../e2e/support/snapshot.ts';

const note = (id: string, over: Record<string, unknown> = {}): Snapshot['notes'][number] => ({
	id, title: `title ${id}`, body: `sha-${id}`, parent_id: 'f1', is_todo: 0, todo_due: 0, todo_completed: 0, is_conflict: 0, deleted_time: 0, updated_time: 100, ...over,
} as Snapshot['notes'][number]);
const folder = (id: string, over: Record<string, unknown> = {}): Snapshot['folders'][number] => ({ id, title: `folder ${id}`, parent_id: '', ...over } as Snapshot['folders'][number]);
const snap = (notes: Snapshot['notes'], folders: Snapshot['folders'] = [folder('f1')]): Snapshot => ({ notes, folders });

describe('snapshot comparison', () => {
	test('sn-01 an identical snapshot has no difference', () => {
		const s = snap([note('n1'), note('n2')]);
		expect(compareSnapshots(s, snap([note('n2'), note('n1')]))).toEqual({ missing: [], changed: [], added: [], conflicts: [] });
	});

	test('sn-02 a note or folder of S0 that is not in S1 is missing, by id', () => {
		const d = compareSnapshots(snap([note('n1'), note('n2')], [folder('f1'), folder('f2')]), snap([note('n1')], [folder('f1')]));
		expect(d.missing.sort()).toEqual(['f2', 'n2']);
	});

	test('sn-03 a changed note is reported by id and the names of its changed fields', () => {
		const d = compareSnapshots(snap([note('n1'), note('n2')]), snap([note('n1', { body: 'sha-other', updated_time: 200 }), note('n2', { parent_id: 'f9' })]));
		expect(d.changed).toEqual([{ id: 'n1', fields: ['body', 'updated_time'] }, { id: 'n2', fields: ['parent_id'] }]);
		expect(compareSnapshots(snap([], [folder('f1')]), snap([], [folder('f1', { title: 'other' })])).changed).toEqual([{ id: 'f1', fields: ['title'] }]);
	});

	test('sn-04 an item only in S1 is added with its kind and parent, and a conflict note is listed', () => {
		const d = compareSnapshots(snap([note('n1')]), snap([note('n1'), note('n3', { parent_id: 'f2' }), note('n4', { is_conflict: 1 })], [folder('f1'), folder('f2', { parent_id: 'f1' })]));
		expect(d.added.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
			{ id: 'f2', kind: 'folder', parentId: 'f1' },
			{ id: 'n3', kind: 'note', parentId: 'f2' },
			{ id: 'n4', kind: 'note', parentId: 'f1' },
		]);
		expect(d.conflicts).toEqual(['n4']);
	});

	test('sn-05 the problem lines carry ids and field names, never a title or a body, and honour what is allowed', () => {
		const s0 = snap([note('n1', { title: 'SECRET-TITLE', body: 'sha-SECRET' }), note('n2')]);
		const s1 = snap([note('n1', { title: 'SECRET-TITLE-2', body: 'sha-SECRET-2' }), note('n3', { title: 'SECRET-ADDED', is_conflict: 1 })]);
		const lines = snapshotProblems(compareSnapshots(s0, s1), {});
		const text = lines.join('\n');
		expect(text).toContain('n2');
		expect(text).toContain('n1');
		expect(text).toContain('title');
		expect(text).toContain('n3');
		expect(text).not.toContain('SECRET');
		// allowed: exactly the expected change set passes; a different field set, or a missing expected change, is a problem
		const d = compareSnapshots(snap([note('n1')]), snap([note('n1', { body: 'x', updated_time: 9 })]));
		expect(snapshotProblems(d, { changed: [{ id: 'n1', fields: ['updated_time', 'body'] }] })).toEqual([]);
		expect(snapshotProblems(d, { changed: [{ id: 'n1', fields: ['body'] }] })).not.toEqual([]);
		expect(snapshotProblems(d, {})).not.toEqual([]);
		expect(snapshotProblems(compareSnapshots(snap([note('n1')]), snap([note('n1')])), { changed: [{ id: 'n1', fields: ['body'] }] })).not.toEqual([]);
		// an added item passes only when the predicate allows it
		const added = compareSnapshots(snap([note('n1')]), snap([note('n1'), note('n5')]));
		expect(snapshotProblems(added, { added: a => a.id === 'n5' })).toEqual([]);
		expect(snapshotProblems(added, { added: a => a.id === 'other' })).not.toEqual([]);
	});
});
