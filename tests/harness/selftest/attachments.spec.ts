// M1-AC20 inner self-test: a test that FAILS ON PURPOSE, so the harness attaches what it attaches on failure (server
// log, web log, supervisor log, browser console, Playwright trace). Run only by tests/contract/m1-s6/ac20-attachments
// .test.ts, which reads the JSON report and checks every attachment (docs/test-plans/M1-S6.md).
// Planted values:
// - in the page: a secret built inside the browser (never in this file, never passed in, so only redaction can keep it
//   out of the trace) is logged to the console as an X-API-AUTH line and as a token= URL, and sent through web to the
//   server in X-API-AUTH and ?token=; the visible marker of the same request is the positive control;
// - the 502 path (carried over from M1-S4): the server is stopped, then this process sends a request through web with
//   marker values in X-API-AUTH, Authorization, Cookie, Cf-Access-Jwt-Assertion, CF-Access-Client-Secret and ?token=,
//   and a unique path marker.
// The real secrets (account and master passwords, the Data API token) and every planted value go to
// $NST_SELFTEST_OUT/planted.json (outside the report and the test output dir) for the outer scan.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../../e2e/support/fixtures.ts';
import { dataApiToken, podmanSync, webRequest } from '../../stack/stack.ts';
import { waitFor } from '../../support/poll.ts';

const hex = (): string => randomBytes(12).toString('hex');

test('M1-AC20 fails on purpose and attaches every log', async ({ stack, e2eeAccount, headlessService, dataApi, webApp }) => {
	const out = process.env.NST_SELFTEST_OUT ?? '';

	// The supervisor has synced and decrypted the account (so its log has content to attach).
	const notes = dataApi.get('/notes?fields=id,title');
	expect(notes.status, JSON.stringify(notes)).toBe(200);

	// In the browser.
	await webApp.page.goto('/');
	const inPage = await webApp.page.evaluate(async () => {
		const rnd = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
		const secret = ['nst', 'secret'].join('') + rnd();
		const visible = `nstvisible${rnd()}`;
		console.warn(`X-API-AUTH: ${secret} (sent with ${visible})`);
		console.warn(`request ${visible}: /joplin-server/api/items?token=${secret}&marker=${visible}`);
		const res = await fetch(`/joplin-server/api/items/root:/${visible}.md:/content?token=${secret}`, { headers: { 'X-API-AUTH': secret } });
		console.warn(`response ${res.status} for ${visible}`);
		return { visible, status: res.status };
	});
	expect(inPage.status).toBe(403);

	// The 502 path: no upstream, a request through web carrying every credential header.
	podmanSync(['stop', '-t', '5', stack.containers.server ?? '']);
	const markers = {
		path: `nstpath${hex()}`,
		xApiAuth: `nstxapiauth${hex()}`,
		authorization: `nstauthorization${hex()}`,
		cookie: `nstcookie${hex()}`,
		cfJwt: `nstcfjwt${hex()}`,
		cfSecret: `nstcfsecret${hex()}`,
		token: `nsttoken${hex()}`,
	};
	const bad = await webRequest(stack, `/joplin-server/api/${markers.path}?token=${markers.token}`, {
		headers: {
			'X-API-AUTH': markers.xApiAuth,
			'Authorization': `Bearer ${markers.authorization}`,
			'Cookie': `session=${markers.cookie}`,
			'Cf-Access-Jwt-Assertion': markers.cfJwt,
			'CF-Access-Client-Secret': markers.cfSecret,
		},
	});
	expect(bad.status).toBe(502);
	// Caddy writes the error entry when the dial fails; wait until it is in the log before the test ends.
	await waitFor('the 502 error entry in the web log', async () => {
		const log = podmanSync(['logs', stack.containers.web ?? '']);
		return `${log.stdout}${log.stderr}`.split('\n').some(l => l.includes(markers.path) && l.includes('"error"')) ? true : undefined;
	}, { timeoutMs: 30_000 });

	writeFileSync(join(out, 'planted.json'), JSON.stringify({
		inPageVisible: inPage.visible,
		markers,
		secrets: [
			{ label: 'account_password', value: e2eeAccount.password },
			{ label: 'master_password', value: e2eeAccount.masterPassword },
			{ label: 'data_api_token', value: dataApiToken(headlessService.container) ?? '' },
		],
	}));

	expect('the harness self-test', 'M1-AC20: this failure is deliberate').toBe('a passing test');
});
