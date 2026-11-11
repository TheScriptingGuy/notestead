// When syncWebOnce presses Synchronise again (docs/test-plans/CI-M2-S2-x64-arm64.md; unit tests syncPress.test.ts).
// The web app starts a sync of its own about two seconds after an edit. A press that lands just after it starts finds the
// button already reading "Cancel" and cancels that sync, so the press produced no sync: no delta request follows (observed
// locally under the CI locale: "Sync: starting" then "Sync: cancelling" 190 ms later). No Playwright import.

// A press is judged lost only after this long: a sync the press started shows its first requests well within it.
export const pressSettleMs = 3_000;

// Presses in all, the first included. Each lost press needs a second sync of the app's own to collide with it.
export const maxPresses = 3;

export interface PressState {
	// a delta request (200) was made since the last press
	deltaSeen: boolean;
	// the button reads "Synchronise" (idle), not "Cancel"
	idle: boolean;
	msSincePress: number;
	presses: number;
}

export const pressAgain = (s: PressState): boolean => !s.deltaSeen && s.idle && s.msSincePress >= pressSettleMs && s.presses < maxPresses;

export interface SyncProbeState { presses: number; pressedAt: number; report: string }
export interface SyncProbeDeps {
	deltaSinceMark: () => boolean;
	idle: () => Promise<boolean>;
	press: () => Promise<void>;
	setMark: () => void;
	report: () => Promise<string>;
	now: () => number;
}
// One probe of syncWebOnce's poll (review CI-M2-S2-r1 C5: the wiring gets a fake-driven test). A re-press sets the mark and
// restarts the clock before it clicks, so the next probe cannot press again at once.
export const syncProbe = async (s: SyncProbeState, d: SyncProbeDeps): Promise<string> => {
	if (!d.deltaSinceMark()) {
		if (pressAgain({ deltaSeen: false, idle: await d.idle(), msSincePress: d.now() - s.pressedAt, presses: s.presses })) {
			s.presses++;
			d.setMark();
			s.pressedAt = d.now();
			await d.press();
			return `pressed again (press ${s.presses}): the last press started no sync`;
		}
		return 'no delta request since the press';
	}
	if (!(await d.idle())) return 'a sync is running';
	s.report = await d.report();
	if (/Last error:/.test(s.report)) return `the sync reported an error: ${s.report}`;
	return /\bCompleted: /.test(s.report) ? 'completed' : `no completed report yet: ${JSON.stringify(s.report)}`;
};
