// Queries over the headless REST Data API for data-level assertions (tests/e2e/support/restQueries.ts; docs/test-plans/
// M2-S2.md F1). CLI 3.7.1 leaves conflict copies out of GET /notes unless include_conflicts=1 is asked, so a check of
// "exactly one note per title, no conflict copy" has to ask for them. The fake `get` below answers like that.
import { describe, expect, test } from '@jest/globals';
import { allItems, noteTagTitles, notesTitled, tagNoteIds, withQuery } from '../../e2e/support/restQueries.ts';
import type { Item, RestGet, RestResult } from '../../e2e/support/restQueries.ts';

interface Fake {
	get: RestGet;
	paths: string[];
}

// Records every path. `answer` gets the path without its `page=` part and the page number.
const fake = (answer: (path: string, page: number) => RestResult): Fake => {
	const paths: string[] = [];
	const get: RestGet = path => {
		paths.push(path);
		const m = /^(.*)&page=(\d+)$/.exec(path);
		if (!m) throw new Error(`the query has no trailing page parameter: ${path}`);
		return answer(m[1], Number(m[2]));
	};
	return { get, paths };
};

const items = (list: Item[], hasMore = false): RestResult => ({ status: 200, body: { items: list, has_more: hasMore } });

describe('rest queries', () => {
	test('rest-01 notesTitled asks for conflict copies and returns them', () => {
		const a = { id: 'a', title: 'T', is_conflict: 0 };
		const b = { id: 'b', title: 'T', is_conflict: 1 };
		const c = { id: 'c', title: 'U', is_conflict: 0 };
		const f = fake(path => (path.includes('include_conflicts=1') ? items([a, b, c]) : items([a, c])));
		expect(notesTitled(f.get, 'T').map(n => n.id)).toEqual(['a', 'b']);
		expect(f.paths).toHaveLength(1);
		expect(f.paths[0]).toMatch(/^\/notes\?include_conflicts=1&fields=id,title,is_conflict,deleted_time&limit=100&page=1$/);
	});

	test('rest-02 trashed notes only when asked', () => {
		const f = fake(() => items([]));
		notesTitled(f.get, 'T');
		notesTitled(f.get, 'T', { includeDeleted: true });
		expect(f.paths[0]).not.toContain('include_deleted');
		expect(f.paths[1]).toContain('include_deleted=1');
		expect(f.paths[1]).toContain('include_conflicts=1');
	});

	test('rest-03 allItems pages until has_more is false', () => {
		const x = { id: 'x' };
		const y = { id: 'y' };
		const f = fake((_path, page) => (page === 1 ? items([x], true) : items([y], false)));
		expect(allItems(f.get, '/folders', 'id')).toEqual([x, y]);
		expect(f.paths).toEqual(['/folders?fields=id&limit=100&page=1', '/folders?fields=id&limit=100&page=2']);
	});

	test('rest-04 a failed request throws naming the path and status, never the body', () => {
		const http404 = fake(() => ({ status: 404, body: 'nstbodymarker' }));
		let message = '';
		try {
			tagNoteIds(http404.get, 't1');
		} catch (error) {
			message = String(error);
		}
		expect(message).toMatch(/GET \/tags\/t1\/notes\?fields=id&limit=100&page=1: HTTP 404/);
		expect(message).not.toContain('nstbodymarker');
		const probe = fake(() => ({ error: 'probe failed' }));
		expect(() => tagNoteIds(probe.get, 't1')).toThrow(/probe failed/);
	});

	test('rest-05 tag helpers', () => {
		const ids = fake(() => items([{ id: 'n2' }, { id: 'n1' }]));
		expect(tagNoteIds(ids.get, 't1')).toEqual(['n1', 'n2']);
		const titles = fake(() => items([{ id: 'a', title: 'zeta' }, { id: 'b', title: 'alpha' }]));
		expect(noteTagTitles(titles.get, 'n1')).toEqual(['alpha', 'zeta']);
		expect(titles.paths[0]).toMatch(/^\/notes\/n1\/tags\?/);
		expect(withQuery('/a?x=1', 'y=2')).toBe('/a?x=1&y=2');
		expect(withQuery('/a', 'y=2')).toBe('/a?y=2');
	});
});
