// The one-line failure the redacting reporter prints as each test ends (tests/e2e/support/failureLine.ts;
// docs/test-plans/CI-M2-S2-x64-arm64.md Decisions C and D). Playwright's `list` reporter prints error details only at the
// end of a run, so a run killed by its step limit left the job log with no failure message at all. The line is redacted
// like every other output of the harness: CI logs are public.
import { describe, expect, jest, test } from '@jest/globals';
import { join } from 'node:path';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import { failureLine } from '../../e2e/support/failureLine.ts';
import type { FailureInput } from '../../e2e/support/failureLine.ts';
import RedactingReporter from '../../e2e/support/redactingReporter.ts';
import type { KnownSecret } from '../../support/redact.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';

const input = (error: string): FailureInput => ({ title: 'T', file: 'tests/e2e/x.spec.ts', line: 7, retry: 1, status: 'failed', durationMs: 72_049, error });

describe('failure line', () => {
	test('ci-fail-01 one line: title, location, attempt, whole seconds and the first line of the error', () => {
		const line = failureLine(input('Error: boom\n    at somewhere (file.ts:1:2)\n    at another (file.ts:3:4)'), []);
		expect(line).toBe('[notestead] FAILED T (tests/e2e/x.spec.ts:7) attempt 2, 72 s: Error: boom');
		expect(line).not.toContain('\n');
	});

	test('ci-fail-02 registered secrets and token query values are redacted', () => {
		const secrets: KnownSecret[] = [{ label: 'account0_password', value: 'nstsecret0123456789abcdef' }];
		const line = failureLine(input('Error: login failed for nstsecret0123456789abcdef at http://127.0.0.1:1/api/x?token=abc123def456&y=1\n    at x'), secrets);
		expect(line).not.toContain('nstsecret0123456789abcdef');
		expect(line).not.toContain('abc123def456');
		expect(line).toContain('[account0_password]');
		expect(line).toContain('?token=[REDACTED]');
	});

	test('ci-fail-03 a long first line is cut to 300 characters plus an ellipsis, and colour codes are dropped', () => {
		const long = failureLine(input(`Error: ${'x'.repeat(1000)}`), []);
		const message = long.slice(long.indexOf(' s: ') + 4);
		expect(message.endsWith('…')).toBe(true);
		expect(message).toHaveLength(301);
		const coloured = failureLine(input('\u001b[31mError: red\u001b[39m'), []);
		expect(coloured.endsWith(': Error: red')).toBe(true);
	});

	// The reporter prints the line as the test ends (CI 39663284028 C, D); the unit tests of the redaction call onTestEnd with
	// partial objects, and a line that cannot be built must never break the redaction.
	describe('in the redacting reporter', () => {
		const written = (run: () => void): string => {
			const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
			try {
				run();
				return spy.mock.calls.map(c => String(c[0])).join('');
			} finally {
				spy.mockRestore();
			}
		};
		const failed = { status: 'failed', retry: 0, duration: 1500, error: { message: 'Error: boom\n at x' }, errors: [], stdout: [], stderr: [], steps: [], attachments: [] } as unknown as TestResult;
		const fullTest = { title: 'T', titlePath: () => ['', 'chromium', 'x.spec.ts', 'suite', 'T'], location: { file: join(findRepoRoot(), 'tests', 'e2e', 'x.spec.ts'), line: 7 } } as unknown as TestCase;

		test('ci-fail-04 a failed test prints its line at once, a passed one prints nothing', () => {
			const reporter = new RedactingReporter();
			expect(written(() => reporter.onTestEnd(fullTest, failed))).toBe('[notestead] FAILED T (tests/e2e/x.spec.ts:7) attempt 1, 2 s: Error: boom\n');
			expect(written(() => reporter.onTestEnd(fullTest, { ...failed, status: 'passed' } as unknown as TestResult))).toBe('');
			expect(written(() => reporter.onTestEnd(fullTest, { ...failed, status: 'skipped' } as unknown as TestResult))).toBe('');
		});

		test('ci-fail-05 a partial test object prints nothing and does not break onTestEnd', () => {
			const reporter = new RedactingReporter();
			expect(written(() => reporter.onTestEnd({} as TestCase, failed))).toBe('');
		});
	});
});
