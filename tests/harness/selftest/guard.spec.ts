// M1-AC19 inner self-test (docs/test-plans/M1-S6.md). With JOPLIN_SERVER_URL naming a server this harness started,
// the body runs against that server (positive control); with any other value the run must abort in globalSetup, so
// this body never runs and $NST_SELFTEST_OUT/body-ran is never written.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../../e2e/support/fixtures.ts';

test('the harness talks to its own server only', async ({ joplinServer, stack }) => {
	const out = process.env.NST_SELFTEST_OUT ?? '';
	writeFileSync(join(out, 'body-ran'), JSON.stringify({ serverUrl: joplinServer.url, project: stack.project, attached: stack.attached === true }));
	const ping = await joplinServer.request('/api/ping');
	expect(ping.status).toBe(200);
	expect(JSON.parse(ping.text)).toMatchObject({ status: 'ok' });
});
