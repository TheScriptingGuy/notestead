// The value-free seed scan (tests/e2e/support/seedScan.ts; review M2-S1-r1 C1): which seeded value occurs in a text is
// named by a label, never by the value, because a failing assertion prints its received value and CI logs are public.
import { describe, expect, test } from '@jest/globals';
import { seedLabelIn } from '../../e2e/support/seedScan.ts';
import type { SeedValues } from '../../e2e/support/seedScan.ts';

// Every value occurs in the others' text (the tag is part of each title, body and the folder).
const overlapping: SeedValues = {
	folder: 'Notestead folder abc12',
	tag: 'abc12',
	notes: [
		{ title: 'Notestead note abc12', body: 'Seeded body abc12 zebracorn' },
		{ title: 'Notestead note 2 abc12', body: 'Seeded body 2 abc12 zebracorn Δ' },
	],
};

// A tag that occurs in none of the other values.
const distinct: SeedValues = {
	folder: 'F one',
	tag: 'zz9',
	notes: [{ title: 'T one', body: 'B one' }, { title: 'T two', body: 'B two' }],
};

describe('seed scan', () => {
	test('seed-01 names the first seeded value found by a label', () => {
		expect(seedLabelIn('x B two y', distinct)).toBe('body 2');
		expect(seedLabelIn('<b>T one</b>', distinct)).toBe('title 1');
		expect(seedLabelIn('F one', distinct)).toBe('folder');
		expect(seedLabelIn('…zz9…', distinct)).toBe('tag');
	});

	test('seed-02 returns undefined when no seeded value occurs', () => {
		expect(seedLabelIn('nothing here', distinct)).toBeUndefined();
		expect(seedLabelIn('nothing here', overlapping)).toBeUndefined();
	});

	test('seed-03 never returns a seeded value', () => {
		for (const seed of [overlapping, distinct]) {
			const values = [seed.tag, seed.folder, ...seed.notes.flatMap(n => [n.title, n.body])];
			for (const v of values) {
				const r = seedLabelIn(`pre ${v} post`, seed);
				expect(r, 'a label is found').toBeDefined();
				const shown = JSON.stringify(r);
				for (const other of values) expect(shown.includes(other), 'the result holds no seeded value').toBe(false);
			}
		}
	});
});
