// One redacted line per failed test, printed as the test ends (docs/test-plans/CI-M2-S2-x64-arm64.md Decisions C and D).
// Playwright's `list` reporter prints error details in its end-of-run epilogue, so a run killed by its step limit left the
// job log with no failure message (CI run 39663284028, arm64). No Playwright import: the unit layer tests it.
//   [notestead] FAILED <title> (<file>:<line>) attempt <n>, <s> s: <first error line>
// The error is redacted first (registered secrets, `token=` values, credential headers) and cut afterwards, so a cut can
// never leave half a secret that redaction would no longer recognise. Only the first line is kept, at most 300 characters.
import { redactText } from '../../support/redact.ts';
import type { KnownSecret } from '../../support/redact.ts';

export interface FailureInput {
	title: string;
	// relative to the repository root
	file: string;
	line: number;
	// Playwright's retry index: 0 for the first attempt
	retry: number;
	status: string;
	durationMs: number;
	error: string;
}

const maxMessage = 300;
// Playwright colours its error messages.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export const failureLine = (input: FailureInput, secrets: KnownSecret[]): string => {
	const redacted = redactText(input.error.replace(ansi, ''), secrets);
	const first = redacted.split('\n').find(l => l.trim() !== '')?.trim() ?? input.status;
	const message = first.length > maxMessage ? `${first.slice(0, maxMessage)}…` : first;
	return `[notestead] FAILED ${redactText(input.title, secrets)} (${input.file}:${input.line}) attempt ${input.retry + 1}, ${Math.round(input.durationMs / 1000)} s: ${message}`;
};
