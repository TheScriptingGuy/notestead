// Data snapshots of an account through the Data API and their comparison (docs/test-plans/M2-S5.md D8). Pure: unit-tested
// (sn-01…05; `restSnapshot` needs the headless Data API). Bodies are kept as sha256 only, and every message names ids and fields, never a value (M2-S2 r1 C4).
import { createHash } from 'node:crypto';
import { allItems } from './restQueries.ts';
import type { RestGet } from './restQueries.ts';

export interface SnapshotNote {
	id: string; title: string;
	// the sha256 of the body
	body: string;
	parent_id: string; is_todo: number; todo_due: number; todo_completed: number; is_conflict: number; deleted_time: number; updated_time: number;
}
export interface SnapshotFolder { id: string; title: string; parent_id: string }
export interface Snapshot { notes: SnapshotNote[]; folders: SnapshotFolder[] }

export interface SnapshotDiff {
	missing: string[];
	changed: { id: string; fields: string[] }[];
	added: { id: string; kind: 'note' | 'folder'; parentId: string }[];
	conflicts: string[];
}

const changedFields = (a: object, b: object): string[] => {
	const x = a as Record<string, unknown>;
	const y = b as Record<string, unknown>;
	return Object.keys(x).filter(k => k !== 'id' && x[k] !== y[k]);
};

export const compareSnapshots = (s0: Snapshot, s1: Snapshot): SnapshotDiff => {
	const diff: SnapshotDiff = { missing: [], changed: [], added: [], conflicts: [] };
	const kinds: ['note' | 'folder', Map<string, object>, Map<string, object>][] = [
		['note', new Map(s0.notes.map(n => [n.id, n])), new Map(s1.notes.map(n => [n.id, n]))],
		['folder', new Map(s0.folders.map(f => [f.id, f])), new Map(s1.folders.map(f => [f.id, f]))],
	];
	for (const [kind, before, after] of kinds) {
		for (const [id, item] of before) {
			const now = after.get(id);
			if (!now) {
				diff.missing.push(id);
				continue;
			}
			const fields = changedFields(item, now);
			if (fields.length > 0) diff.changed.push({ id, fields });
		}
		for (const [id, item] of after) {
			if (!before.has(id)) diff.added.push({ id, kind, parentId: String((item as { parent_id: unknown }).parent_id) });
		}
	}
	diff.conflicts = s1.notes.filter(n => n.is_conflict === 1).map(n => n.id);
	return diff;
};

// The value-free problem lines of a diff. `allowed.changed` is the exact set of expected changes (every one must be present with
// exactly these fields); `allowed.added` says which added items are expected.
export const snapshotProblems = (diff: SnapshotDiff, allowed: { changed?: { id: string; fields: string[] }[]; added?: (a: SnapshotDiff['added'][number]) => boolean }): string[] => {
	const problems: string[] = [];
	for (const id of diff.missing) problems.push(`missing: ${id} is in the first snapshot and not in the second`);
	const expected = new Map((allowed.changed ?? []).map(c => [c.id, [...c.fields].sort().join(',')]));
	for (const c of diff.changed) {
		const fields = [...c.fields].sort().join(',');
		if (!expected.has(c.id)) problems.push(`changed: ${c.id} (${fields})`);
		else if (expected.get(c.id) !== fields) problems.push(`changed: ${c.id} (${fields}), expected (${expected.get(c.id)})`);
	}
	for (const id of expected.keys()) if (!diff.changed.some(c => c.id === id)) problems.push(`not changed: ${id} was expected to change`);
	for (const a of diff.added) if (!(allowed.added?.(a) ?? false)) problems.push(`added: ${a.id} (${a.kind} in ${a.parentId || 'the root'})`);
	for (const id of diff.conflicts) problems.push(`conflict: ${id}`);
	return problems;
};

// ---- Reading a snapshot (needs the headless Data API) ----
const noteFields = 'id,title,body,parent_id,is_todo,todo_due,todo_completed,is_conflict,deleted_time,updated_time';

// Every note (conflict copies and trashed notes included) and every notebook of the account, through the REST Data API, paged until
// `has_more` is false. Bodies are kept as their sha256 only.
export const restSnapshot = (dataApi: { get: RestGet }): Snapshot => ({
	notes: allItems(dataApi.get, '/notes?include_conflicts=1&include_deleted=1', noteFields).map(n => ({
		id: String(n.id), title: String(n.title), body: createHash('sha256').update(String(n.body ?? ''), 'utf8').digest('hex'),
		parent_id: String(n.parent_id), is_todo: Number(n.is_todo), todo_due: Number(n.todo_due), todo_completed: Number(n.todo_completed),
		is_conflict: Number(n.is_conflict), deleted_time: Number(n.deleted_time), updated_time: Number(n.updated_time),
	})),
	folders: allItems(dataApi.get, '/folders', 'id,title,parent_id').map(f => ({ id: String(f.id), title: String(f.title), parent_id: String(f.parent_id) })),
});
