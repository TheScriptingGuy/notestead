// The placement criterion of the Source link (tests/e2e/support/placement.ts; docs/test-plans/M2-S6.md D8; ADR-0010: the Source
// link never covers upstream controls). A control is covered if the element at the centre of its box is the link, or if the
// link covers at least a quarter of its box. Boxes are in page coordinates.
import { describe, expect, test } from '@jest/globals';
import { coveredControls } from '../../e2e/support/placement.ts';
import type { Control } from '../../e2e/support/placement.ts';

const link = { x: 0, y: 780, width: 60, height: 20 };
const control = (name: string, box: Control['box'], extra: Partial<Control> = {}): Control => ({ role: 'button', name, box, centreHitsLink: false, ...extra });

describe('source link placement', () => {
	test('cov-01 a control that does not intersect the link is not covered', () => {
		expect(coveredControls([control('Synchronise', { x: 100, y: 700, width: 200, height: 40 })], link)).toEqual([]);
		// touching edges is no overlap
		expect(coveredControls([control('Edge', { x: 60, y: 780, width: 100, height: 20 })], link)).toEqual([]);
	});

	test('cov-02 a control whose centre is under the link is covered, whatever the overlap share', () => {
		const wide = control('Wide row', { x: 0, y: 770, width: 600, height: 40 }, { centreHitsLink: true });
		const covered = coveredControls([wide], link);
		expect(covered.map(c => c.control.name)).toEqual(['Wide row']);
		expect(covered[0].share).toBeCloseTo((60 * 20) / (600 * 40), 5);
	});

	test('cov-03 a control overlapped by 30 percent with its centre outside is covered', () => {
		const c = control('Settings', { x: 30, y: 780, width: 100, height: 20 }); // 30 of 100 px of width are under the link
		const covered = coveredControls([c], link);
		expect(covered).toHaveLength(1);
		expect(covered[0].share).toBeCloseTo(0.3, 5);
	});

	test('cov-04 a control overlapped by 10 percent with its centre outside is not covered (a wide list row), and minShare is respected', () => {
		const row = control('A note', { x: 50, y: 780, width: 100, height: 20 }); // 10 of 100 px
		expect(coveredControls([row], link)).toEqual([]);
		expect(coveredControls([row], link, 0.05)).toHaveLength(1);
		// exactly 25 percent is covered (at least)
		expect(coveredControls([control('Quarter', { x: 35, y: 780, width: 100, height: 20 })], link)).toHaveLength(1);
	});

	test('cov-05 the link itself is excluded, and every covered control is reported in order', () => {
		const self = control('Source', { x: 0, y: 780, width: 60, height: 20 }, { role: 'link', centreHitsLink: true });
		const a = control('A', { x: 0, y: 780, width: 40, height: 20 });
		const b = control('B', { x: 500, y: 100, width: 40, height: 20 });
		const c = control('C', { x: 10, y: 790, width: 40, height: 20 });
		expect(coveredControls([{ ...self, isSourceLink: true }, a, b, c], link).map(x => x.control.name)).toEqual(['A', 'C']);
	});
});
