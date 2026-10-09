// Playwright reporter that redacts every attachment of a finished test, in place, before any other reporter reads it
// (it is listed first in playwright.config.ts; the HTML, JSON and JUnit reporters copy attachments only at onEnd).
// Covers what the fixtures cannot: the Playwright trace (a zip whose network entries carry request headers and URLs),
// Playwright's own error-context, and any attachment added by a test. ADR-0007/0008: no unredacted token= or
// credential header value in any artifact (M1-AC20).
import { rmSync } from 'node:fs';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { redactBuffer, redactFile } from '../../support/redact.ts';
import type { KnownSecret } from '../../support/redact.ts';

const stackSecrets = (): KnownSecret[] => {
	const raw = process.env.NOTESTEAD_E2E_STACK;
	if (!raw) return [];
	try {
		const state = JSON.parse(raw) as { accounts?: { password: string; masterPassword: string }[] };
		return (state.accounts ?? []).flatMap((a, i) => [
			{ label: `account${i}_password`, value: a.password },
			{ label: `account${i}_master_password`, value: a.masterPassword },
		]);
	} catch {
		return [];
	}
};

export default class RedactingReporter implements Reporter {
	public onTestEnd(_test: TestCase, result: TestResult): void {
		const secrets = stackSecrets();
		for (const attachment of result.attachments as { path?: string; body?: Buffer }[]) {
			try {
				if (attachment.path) redactFile(attachment.path, secrets);
				if (attachment.body) attachment.body = redactBuffer(attachment.body, secrets);
			} catch (error) {
				// An attachment that cannot be redacted is not kept.
				process.stderr.write(`redacting reporter: dropping an attachment it could not redact (${(error as Error).message})\n`);
				if (attachment.path) rmSync(attachment.path, { force: true });
				attachment.path = undefined;
				attachment.body = Buffer.from('[attachment removed: it could not be redacted]');
			}
		}
	}

	public printsToStdio(): boolean {
		return false;
	}
}
