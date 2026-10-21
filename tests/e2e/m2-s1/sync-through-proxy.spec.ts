// M2-S1 / M2-AC1 (docs/backlog/M2.md §M2-S1; docs/test-plans/M2-S1.md): the web app is configured like a user would, with
// "Joplin Server" at <web origin>/joplin-server and a test user's credentials, in a fresh context. "Check synchronisation
// configuration" succeeds, a full sync completes, and every request the browser made obeys the network policy: the sync
// target only through same-origin /joplin-server/api/*, the sole cross-origin exception HEAD joplinapp.org/connection_check/.
// Interpretation 1: the test user is a fresh plain (non-E2EE) account, so the first sync can complete without an error
// (an E2EE account reports "Master key is not loaded" until the password is entered, Finding F4). Its info.json on the
// server, written by the web app through the proxy, has version 3 (the pinned sync version).
// Interpretation 2: the policy (tests/e2e/support/network.ts). Interpretation 3: the recorder observes, it never routes.
// Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { configureAndCheckJoplinServerSync, firstSyncTimeoutMs } from '../support/flows.ts';
import { classifyRequests, violationLines } from '../support/network.ts';
import { JoplinWebApp } from '../support/pages/joplinWebApp.ts';
import { registerSecrets } from '../../support/secrets.ts';
import { readVersionPin } from '../../support/repoRoot.ts';
import { serverItemContent, serverItemNames } from '../../stack/stack.ts';

test.describe('M2-S1 sync through the proxy', () => {
	test('M2-AC1 configures Joplin Server at <origin>/joplin-server, the check succeeds and a full sync completes, with only same-origin sync traffic and info.json version 3', async ({ stack, joplinServer, plainAccount, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S1');
		const app = new JoplinWebApp(webApp.page);
		const origin = new URL(webApp.baseURL).origin;

		await test.step('1. configure the sync target like a user and check the configuration', async () => {
			expect(joplinServer.proxiedUrl).toBe(`${origin}/joplin-server`);
			const settings = await configureAndCheckJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, plainAccount);
			expect(await settings.configCheckStatus()).toBe('success');
		});

		await test.step('2. the successful check saved the settings', async () => {
			await expect(webApp.page.getByRole('button', { name: 'Save changes', exact: true, disabled: true })).toBeVisible();
			await webApp.page.getByRole('button', { name: 'Back', exact: true }).click();
		});

		await test.step('3. a full sync completes', async () => {
			await app.openSidebar();
			await expect.poll(async () => {
				if (!(await app.syncIdle().isVisible())) return 'a sync is running';
				const report = await app.syncReport();
				if (/Last error:/.test(report)) return `the sync reported an error: ${report}`;
				return /Completed: /.test(report) ? 'completed' : `no completed report yet: ${JSON.stringify(report)}`;
			}, { timeout: firstSyncTimeoutMs, intervals: [1_000] }).toBe('completed');
		});

		await test.step('4. the sync went through the proxy', async () => {
			const { syncTraffic } = classifyRequests(webNetwork.entries(), origin);
			const login = syncTraffic.filter(e => e.method === 'POST' && new URL(e.url).pathname === '/joplin-server/api/sessions');
			expect(login.map(e => e.status), 'POST /joplin-server/api/sessions').toContain(200);
			const infoJson = syncTraffic.filter(e => e.method === 'PUT' && decodeURIComponent(new URL(e.url).pathname) === '/joplin-server/api/items/root:/info.json:/content');
			expect(infoJson.length, 'PUT of info.json through the proxy').toBeGreaterThan(0);
			expect(infoJson.every(e => (e.status ?? 0) >= 200 && (e.status ?? 0) < 300), `PUT info.json statuses: ${infoJson.map(e => e.status).join(', ')}`).toBe(true);
		});

		await test.step('5. data level: the server\'s info.json has version 3', async () => {
			const info = await serverItemContent(stack, plainAccount, 'info.json');
			expect(info.status, 'GET info.json from the server').toBe(200);
			const version = (JSON.parse(info.text) as { version?: unknown }).version;
			expect(version).toBe(3);
			expect(version).toBe(readVersionPin().syncVersion);
		});

		await test.step('6. network policy', async () => {
			const verdict = classifyRequests(webNetwork.entries(), origin);
			expect(violationLines(verdict)).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
			expect(verdict.syncTraffic.length).toBeGreaterThan(0);
			expect(webNetwork.entries().some(e => e.fromServiceWorker), 'the recorder sees service-worker requests').toBe(true);
		});

		await test.step('7. control: a planted cross-origin request is seen and flagged', async () => {
			// The planted control is named, so the end-of-test check (C2) leaves out exactly this request.
			webNetwork.allow('https://notestead-control.invalid/');
			// Step 6 has already been evaluated, so this control cannot hide a real violation.
			await webApp.page.evaluate(() => fetch('https://notestead-control.invalid/m2-ac1', { mode: 'no-cors' }).then(() => 'sent', () => 'failed'));
			await expect.poll(() => violationLines(classifyRequests(webNetwork.entries(), origin)).some(l => l.includes('notestead-control.invalid/m2-ac1'))).toBe(true);
		});
	});

	test('M2-AC1 NEG a wrong sync password fails the check with upstream\'s error, and nothing is saved or synced', async ({ stack, joplinServer, plainAccount, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S1');
		const app = new JoplinWebApp(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const wrong = `nstwrong${randomBytes(12).toString('hex')}`;
		registerSecrets([{ label: 'm2_ac1_wrong_password', value: wrong }]);

		await test.step('1. the same flow with a wrong password: the check fails with upstream\'s error', async () => {
			const settings = await configureAndCheckJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, plainAccount, { password: wrong });
			expect(await settings.configCheckStatus()).toBe('error');
			const error = await settings.configCheckError();
			expect(error).toContain('The reported error was:');
			expect(error).toContain('Invalid email or password');
		});

		await test.step('2. nothing was saved: "Save changes" is still enabled', async () => {
			await expect(webApp.page.getByRole('button', { name: 'Save changes', exact: true, disabled: false })).toBeVisible();
		});

		await test.step('3. the network log shows the refused login and no sync', async () => {
			const verdict = classifyRequests(webNetwork.entries(), origin);
			const login = verdict.syncTraffic.filter(e => e.method === 'POST' && new URL(e.url).pathname === '/joplin-server/api/sessions');
			expect(login.map(e => e.status), 'POST /joplin-server/api/sessions').toContain(403);
			expect(verdict.syncTraffic.filter(e => new URL(e.url).pathname.startsWith('/joplin-server/api/items/')).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no item request').toEqual([]);
			expect(violationLines(verdict)).toEqual([]);
		});

		await test.step('4. data level: the server holds no item of the account', async () => {
			expect(await serverItemNames(stack, plainAccount)).toEqual([]);
		});
	});
});
