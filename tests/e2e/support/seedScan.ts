import { isDeepStrictEqual } from 'node:util';
// Which seeded value occurs in a text, named by a label, never the value (review M2-S1-r1 C1: a failing assertion
// prints its received value, and CI logs are public). Order: tag, folder, titles, bodies; n counts from 1.
export interface SeedValues { folder: string; tag: string; notes: { title: string; body: string }[] }

export const seedLabelIn = (text: string, seed: SeedValues): string | undefined => {
	if (text.includes(seed.tag)) return 'tag';
	if (text.includes(seed.folder)) return 'folder';
	const t = seed.notes.findIndex(n => text.includes(n.title));
	if (t >= 0) return `title ${t + 1}`;
	const b = seed.notes.findIndex(n => text.includes(n.body));
	return b >= 0 ? `body ${b + 1}` : undefined;
};

// The names of the fields of `expected` whose values differ in `actual`, sorted; never a value (M2-S2 r1 C4: a failing
// check of seeded data names what differs, as seedLabelIn names what it found).
export const fieldsThatDiffer = (actual: Record<string, unknown>, expected: Record<string, unknown>): string[] =>
	Object.keys(expected).filter(k => !isDeepStrictEqual(actual[k], expected[k])).sort();
