// One redacted line per failed test, printed as the test ends (docs/test-plans/CI-M2-S2-x64-arm64.md Decisions C and D).
// Playwright's `list` reporter prints error details in its end-of-run epilogue, so a run killed by its step limit left the
// job log with no failure message (CI run 39663284028, arm64). No Playwright import: the unit layer tests it.
//   [notestead] FAILED <title> (<file>:<line>) attempt <n>, <s> s: <first error line>
// The error is redacted first (registered secrets, `token=` values, credential headers) and cut afterwards, so a cut can
// never leave half a secret that redaction would no longer recognise. The first line is kept, plus for a matcher or timeout
// its first Expected/Received or waiting-for lines (review CI-M2-S2-r1 C1), at most 300 characters in all.
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

const matcherHeader = /^Error: expect\(/;
const timeoutHeader = /TimeoutError|Timeout \d+ms exceeded/;
const detailLine = (lines: string[], pattern: RegExp): string | undefined => lines.map(l => l.trim().replace(/^-\s*/, '')).find(l => pattern.test(l));
// A matcher's header or a Playwright timeout names the kind of failure, not what failed; the first Expected and Received
// lines, or the call log's first "waiting for" line, do (review CI-M2-S2-r1 C1). Redacted before the cut, as the first line.
const details = (lines: string[], first: string): string[] => {
	if (matcherHeader.test(first)) {
		const found = [detailLine(lines, /^Expected\b/), detailLine(lines, /^Received\b/)].filter((l): l is string => !!l);
		const waiting = detailLine(lines, /^waiting for\b/);
		return found.length < 2 && waiting ? [...found, waiting] : found;
	}
	if (timeoutHeader.test(first)) {
		const waiting = detailLine(lines, /^waiting for\b/);
		return waiting ? [waiting] : [];
	}
	return [];
};

export const failureLine = (input: FailureInput, secrets: KnownSecret[]): string => {
	const redacted = redactText(input.error.replace(ansi, ''), secrets);
	const first = redacted.split('\n').find(l => l.trim() !== '')?.trim() ?? input.status;
	const full = [first, ...details(redacted.split('\n').slice(1), first)].join(' | ');
	const message = full.length > maxMessage ? `${full.slice(0, maxMessage)}…` : full;
	return `[notestead] FAILED ${redactText(input.title, secrets)} (${input.file}:${input.line}) attempt ${input.retry + 1}, ${Math.round(input.durationMs / 1000)} s: ${message}`;
};
