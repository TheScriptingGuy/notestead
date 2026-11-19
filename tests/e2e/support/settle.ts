// Where upstream puts the focus when a new note or to-do opens in edit mode (Note.tsx scheduleFocusUpdate: a to-do's title,
// a note's body, which is the Markdown editor; docs/test-plans/M2-S3.md F5), and a tracker that says when the focus has
// stayed there for n polls in a row (M2-S2 r1 C1). No Playwright import.
export type FocusTarget = 'title' | 'editor';
export const focusTargetFor = (kind: 'note' | 'todo'): FocusTarget => (kind === 'todo' ? 'title' : 'editor');
export const settleTracker = (target: string, polls: number): ((owner: string) => boolean) => {
	if (!(polls >= 1)) throw new Error(`a settle needs at least one poll (${polls})`);
	let steady = 0;
	return owner => {
		steady = owner === target ? steady + 1 : 0;
		return steady >= polls;
	};
};
