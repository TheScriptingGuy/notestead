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
