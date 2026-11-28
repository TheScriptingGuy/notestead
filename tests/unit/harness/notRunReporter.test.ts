// "Not run" counts as failed (docs/test-plans/M2-S5.md D9, M2-S1 r1 C3): which test results are not runs (nr-01…04).
import { describe, expect, test } from '@jest/globals';
import { notRunTests } from '../../e2e/support/notRun.ts';

const entry = (status: string, title = 't', project = 'chromium-serial', file = 'a.serial.spec.ts'): { project: string; file: string; title: string; status: string } => ({ project, file, title, status });

describe('not-run tests', () => {
	test('nr-01 skipped and interrupted results are not runs', () => {
		const r = notRunTests([entry('skipped', 'one'), entry('interrupted', 'two')]);
		expect(r.count).toBe(2);
		expect(r.tests.map(t => t.status)).toEqual(['skipped', 'interrupted']);
	});

	test('nr-02 passed, failed and timed-out results are runs', () => {
		expect(notRunTests([entry('passed'), entry('failed'), entry('timedOut')])).toEqual({ count: 0, tests: [] });
	});

	test('nr-03 every not-run test is listed with its project, file and title', () => {
		const r = notRunTests([entry('passed', 'ok'), entry('skipped', 'blocked one', 'chromium-serial', 'x.serial.spec.ts'), entry('interrupted', 'cut off', 'chromium', 'y.spec.ts')]);
		expect(r.tests).toEqual([
			{ project: 'chromium-serial', file: 'x.serial.spec.ts', title: 'blocked one', status: 'skipped' },
			{ project: 'chromium', file: 'y.spec.ts', title: 'cut off', status: 'interrupted' },
		]);
	});

	test('nr-04 no entries is no failure', () => {
		expect(notRunTests([])).toEqual({ count: 0, tests: [] });
	});
});
