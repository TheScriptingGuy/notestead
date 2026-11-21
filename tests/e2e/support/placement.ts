// The placement criterion of the Source link (docs/test-plans/M2-S6.md D8; ADR-0010: the link never covers upstream controls).
// A pure function over boxes in page coordinates, unit-tested in tests/unit/harness/placement.test.ts. The E2E spec collects the
// controls from the page; this decides which of them the link covers.

export interface Box { x: number; y: number; width: number; height: number }

export interface Control {
	role: string;
	name: string;
	box: Box;
	// elementFromPoint at the centre of the control's visible box is the Source link or inside it
	centreHitsLink: boolean;
	// the Source link itself: never reported
	isSourceLink?: boolean;
}

export interface Covered { control: Control; share: number }

const intersectionArea = (a: Box, b: Box): number => {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
};

// The controls the link covers: the point at the centre of the control is the link, or the link overlaps at least `minShare`
// of the control's box (a wide list row that the link only grazes is not covered). `share` is the overlap over the control's area.
export const coveredControls = (controls: Control[], link: Box, minShare = 0.25): Covered[] => {
	const covered: Covered[] = [];
	for (const control of controls) {
		if (control.isSourceLink) continue;
		const area = control.box.width * control.box.height;
		const share = area > 0 ? intersectionArea(control.box, link) / area : 0;
		if (control.centreHitsLink || share >= minShare) covered.push({ control, share });
	}
	return covered;
};
