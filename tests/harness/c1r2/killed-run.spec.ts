// C1-R2 inner spec (M1-S8; docs/test-plans/M1-S8.md §C1-R2), run only by tests/integration/harness/c1r2-killed-run.test.ts
// through tests/harness/playwright.c1r2.config.ts. It registers a secret, leaves it in a trace-like zip (attached, as
// the webApp fixture attaches its trace) and in an output file, then signals the outer test. NST_C1R2_MODE=kill: it
// waits until the outer test kills the whole run (before the redacting reporter's onTestEnd, as a CI timeout or
// cancellation would); otherwise it fails on purpose, so the run finishes normally (the positive control).
import { writeFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { waitFor } from '../../support/poll.ts';
import { registerSecrets } from '../../support/secrets.ts';
import { writeZip } from '../../support/zip.ts';

test('C1-R2 inner: an unredacted trace, then killed or a deliberate failure', async ({ browserName }, testInfo) => {
	const secret = process.env.NST_C1R2_SECRET ?? '';
	const ready = process.env.NST_C1R2_READY ?? '';
	if (secret === '' || ready === '') throw new Error('run by tests/integration/harness/c1r2-killed-run.test.ts only');
	testInfo.annotations.push({ type: 'browser (not launched)', description: browserName });
	registerSecrets([{ label: 'c1r2_secret', value: secret }]);
	const trace = testInfo.outputPath('trace.zip');
	writeFileSync(trace, writeZip([{ name: 'resources/login.json', data: Buffer.from(JSON.stringify({ password: secret })) }]));
	await testInfo.attach('trace', { path: trace, contentType: 'application/zip' });
	writeFileSync(testInfo.outputPath('typed.txt'), `typed ${secret}\n`);
	writeFileSync(ready, 'ready\n');
	if (process.env.NST_C1R2_MODE === 'kill') {
		await waitFor('the outer test to kill this run', async () => undefined, { timeoutMs: 2 * 60_000, intervalMs: 500 });
	}
	throw new Error('C1-R2: this failure is deliberate');
});
