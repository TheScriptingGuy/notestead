// How a test leaves a note it has just trashed (docs/test-plans/CI-M2-S2-x64-arm64.md, finding E). After "Delete" upstream
// either stays on the note screen (seen on the Pi) or leaves it by itself (seen on the CI runners), so the page object accepts
// both. No Playwright import: the unit layer tests it.

// The note screen still showing this long after Delete, with Back visible, means upstream stayed.
export const stayedAfterMs = 3_000;

export interface TrashScreen {
	// the note list is showing (the Sidebar button, no title field)
	onList: boolean;
	// the note screen is showing (its title field is visible)
	onNote: boolean;
	backVisible: boolean;
	msSinceDelete: number;
}

export const trashExit = (s: TrashScreen): 'left' | 'stayed' | undefined => {
	if (s.onList && !s.onNote) return 'left';
	if (s.onNote && s.backVisible && s.msSinceDelete >= stayedAfterMs) return 'stayed';
	return undefined;
};

// After `stayed`, the Back press can race with upstream leaving the trashed note by itself a moment later (CI-M2-S2 r2 C1): the
// click then times out or finds its element detached. `left`: the screen is the list, or the click went through. `fail`: the click
// timed out and the note screen is still showing. `retry`: nothing decides yet, observe again.
export const afterStayed = (click: 'done' | 'detached' | 'timeout', s: TrashScreen): 'left' | 'retry' | 'fail' => {
	if (click === 'done') return 'left';
	if (s.onList && !s.onNote) return 'left';
	if (click === 'timeout' && s.onNote) return 'fail';
	return 'retry';
};
