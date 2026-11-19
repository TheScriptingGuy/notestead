// The seed's items on the server, one by one (tests/stack/seedCheck.ts missingSeedItems; docs/test-plans/M2-S3-work-orders.md
// WO-30): the first full M2-S3 regression run found a seed whose note reached the server but whose folder did not, and the
// headless client then fetched one item. The result names kinds only, never an id or a title.
import { describe, expect, test } from '@jest/globals';
import { missingSeedItems } from '../../stack/seedCheck.ts';

const folder = '0123456789abcdef0123456789abcdef';
const note = 'fedcba9876543210fedcba9876543210';
const todo = '11111111111111111111111111111111';
const expected = [{ kind: 'folder' as const, id: folder }, { kind: 'note' as const, id: note }];

describe('seed items', () => {
	test('seed-items-01 every item\'s .md on the server gives nothing missing', () => {
		expect(missingSeedItems(expected, ['info.json', `${folder}.md`, `${note}.md`, '.sync/version.txt'])).toEqual([]);
		expect(missingSeedItems([...expected, { kind: 'todo', id: todo }], [`${todo}.md`, `${folder}.md`, `${note}.md`])).toEqual([]);
	});

	test('seed-items-02 a missing item is named by its kind', () => {
		expect(missingSeedItems(expected, [`${note}.md`])).toEqual(['folder']);
		expect(missingSeedItems([...expected, { kind: 'todo', id: todo }, { kind: 'attachment-note', id: '2'.repeat(32) }], [`${folder}.md`, `${note}.md`])).toEqual(['todo', 'attachment-note']);
	});

	test('seed-items-03 the result never contains an id or a title', () => {
		const shown = JSON.stringify(missingSeedItems([...expected, { kind: 'todo', id: todo }], []));
		for (const id of [folder, note, todo]) expect(shown.includes(id)).toBe(false);
		expect(shown).toBe('["folder","note","todo"]');
	});
});
