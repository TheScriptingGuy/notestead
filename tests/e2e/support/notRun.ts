// "Not run" counts as failed (docs/test-plans/M2-S5.md D9, M2-S1 r1 C3). Pure: unit-tested (nr-01…04).
export interface RunEntry { project: string; file: string; title: string; status: string }

const notRunStatuses = new Set(['skipped', 'interrupted']);

// The suite has no skips by rule and @network tests are filtered before the run, so a skipped or interrupted last result is a
// test that did not run: a failure in a project it depends on, or a run that stopped.
export const notRunTests = (entries: RunEntry[]): { count: number; tests: RunEntry[] } => {
	const tests = entries.filter(e => notRunStatuses.has(e.status)).map(e => ({ project: e.project, file: e.file, title: e.title, status: e.status }));
	return { count: tests.length, tests };
};
