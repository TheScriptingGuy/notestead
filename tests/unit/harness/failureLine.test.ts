// The one-line failure the redacting reporter prints as each test ends (tests/e2e/support/failureLine.ts;
// docs/test-plans/CI-M2-S2-x64-arm64.md Decisions C and D). Playwright's `list` reporter prints error details only at the
// end of a run, so a run killed by its step limit left the job log with no failure message at all. The line is redacted
// like every other output of the harness: CI logs are public.
import { describe, expect, jest, test } from '@jest/globals';
import { join } from 'node:path';
import { secretsFileEnv, createSecretsFile, registerSecrets, removeSecretsFile } from '../../support/secrets.ts';
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

	test('ci-fail-06 a matcher failure appends its first Expected and Received lines', () => {
		const error = [
			'Error: expect(received).toBe(expected) // Object.is equality',
			'',
			'Expected: "completed"',
			'Received: "no delta request since the press"',
			'',
			'Call Log:',
			'- Timeout 180000ms exceeded while waiting on the predicate',
		].join('\n');
		expect(failureLine(input(error), []).endsWith(': Error: expect(received).toBe(expected) // Object.is equality | Expected: "completed" | Received: "no delta request since the press"')).toBe(true);
	});

	test('ci-fail-07 a timeout appends its first waiting-for line', () => {
		const timeout = ['TimeoutError: locator.click: Timeout 60000ms exceeded.', 'Call log:', '  - waiting for getByRole(\'button\', { name: \'nst-never-there\' })'].join('\n');
		expect(failureLine(input(timeout), []).endsWith(': TimeoutError: locator.click: Timeout 60000ms exceeded. | waiting for getByRole(\'button\', { name: \'nst-never-there\' })')).toBe(true);
		const visible = ['Error: expect(locator).toBeVisible() failed', '', 'Locator: getByRole(\'button\')', 'Expected: visible', 'Timeout: 5000ms', 'Error: element(s) not found', '', 'Call log:', '  - Expect "toBeVisible" with timeout 5000ms', '  - waiting for getByRole(\'button\')'].join('\n');
		expect(failureLine(input(visible), []).endsWith(': Error: expect(locator).toBeVisible() failed | Expected: visible | waiting for getByRole(\'button\')')).toBe(true);
	});

	test('ci-fail-08 the detail is redacted before the cut', () => {
		const secrets: KnownSecret[] = [{ label: 'failline_secret', value: 'nstfailline0123456789abcdef' }];
		const withSecret = failureLine(input('Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "ok"\nReceived: "nstfailline0123456789abcdef"'), secrets);
		expect(withSecret).toContain('Received: "[failline_secret]"');
		expect(withSecret).not.toContain('nstfailline0123456789abcdef');
		// the cut falls inside the redacted label: no part of the secret can be left
		const first = `Error: expect(received).toBe(expected) // ${'x'.repeat(208)}`;
		expect(first).toHaveLength(250);
		const cut = failureLine(input(`${first}\n\nExpected: "completed"\nReceived: "nstfailline0123456789abcdef"`), secrets);
		const message = cut.slice(cut.indexOf(' s: ') + 4);
		expect(message).toHaveLength(301);
		expect(message.endsWith('…')).toBe(true);
		expect(message).not.toContain('nstfaill');
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

		test('ci-fail-09 the reporter path redacts a registered secret in the detail', () => {
			const saved = process.env[secretsFileEnv];
			const file = createSecretsFile();
			try {
				registerSecrets([{ label: 'failline_secret', value: 'nstfailline0123456789abcdef' }]);
				const reporter = new RedactingReporter();
				const leaking = { ...failed, error: { message: 'Error: expect(received).toBe(expected) // Object.is equality\n\nReceived: "nstfailline0123456789abcdef"' } } as unknown as TestResult;
				const line = written(() => reporter.onTestEnd(fullTest, leaking));
				expect(line).toContain('[failline_secret]');
				expect(line).not.toContain('nstfailline0123456789abcdef');
			} finally {
				if (saved === undefined) delete process.env[secretsFileEnv];
				else process.env[secretsFileEnv] = saved;
				removeSecretsFile(file);
			}
		});

		test('ci-fail-05 a partial test object prints nothing and does not break onTestEnd', () => {
			const reporter = new RedactingReporter();
			expect(written(() => reporter.onTestEnd({} as TestCase, failed))).toBe('');
		});
	});
});
