// The E2E projects (ADR-0007 A3, docs/test-plans/M2-S1.md §Disruptive tests): a spec that stops, restarts or
// reconfigures a shared service of the run's stack is named *.serial.spec.ts and runs in `chromium-serial`: one
// worker, after the parallel project has finished (`dependencies`), so nothing runs beside it.
export const serialSpecPattern = '**/*.serial.spec.ts';

export interface E2eProject {
	name: string;
	use: Record<string, unknown>;
	testIgnore?: string;
	testMatch?: string;
	workers?: number;
	fullyParallel?: boolean;
	dependencies?: string[];
}

export const e2eProjects = (desktopChrome: Record<string, unknown>): E2eProject[] => [
	{ name: 'chromium', use: { ...desktopChrome }, testIgnore: serialSpecPattern },
	{ name: 'chromium-serial', use: { ...desktopChrome }, testMatch: serialSpecPattern, workers: 1, fullyParallel: false, dependencies: ['chromium'] },
];
