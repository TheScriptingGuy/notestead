// H-SWU-01 (docs/test-plans/M2-S5.md RU-9, WO-10): a characterisation of upstream's service-worker update reload. A page that loaded
// with bundle A is unloaded, `web` is redeployed with a bundle whose `serviceWorker.bundle.js` differs, and the page is loaded once
// again: upstream's page script then logs "Reloading page to make use of updated COOP/COEP Service Worker." and reloads itself
// (serviceWorker.ts:272-280). `M2-AC16-03` once saw that reload never navigate. This test repeats the switch six times (B2, A, B2, A,
// B2, A), records a CDP timeline of the worker versions and of the main frame's navigation for each, collects all six outcomes and
// asserts once. No account, no headless service. A failure is a measurement. Run twice: with Playwright's service-worker network
// instrumentation on (default) and off (PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK=1).
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { JoplinWebApp, appStartTimeoutMs } from '../support/pages/joplinWebApp.ts';
import { bundleMarker } from '../support/swState.ts';
import { activeVersionBefore, classifySelfReload, recordSwTimeline, updatedWorkerLine, userReload } from '../support/swTimeline.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { waitFor } from '../../support/poll.ts';
import { freePort } from '../../stack/stack.ts';

test.describe('M2-S5 harness: service-worker update reload', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('H-SWU-01 six switches that change the worker each end in the page\'s own reload committing', async ({ stack, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const port = await freePort();
		let web = await extraWebs.start({ role: 'web-extra', port, mountDist: testBundles.a });
		const ctx = await appContexts.open(web.url, 'swu');
		const app = new JoplinWebApp(ctx.page);
		await app.open(web.url);

		const sw = await recordSwTimeline(ctx.page);
		const events = sw.events;

		const outcomes: string[] = [];
		const failures: string[] = [];
		let committed = 0;
		let races = 0;
		let updated = 0;
		for (let i = 1; i <= 6; i++) {
			const toB2 = i % 2 === 1;
			const expected = toB2 ? `B2-${testBundles.nonce}` : null;
			await ctx.page.goto('about:blank');
			web = await extraWebs.redeploy(web, { mountDist: toB2 ? testBundles.b2 : testBundles.a });
			const consoleMark = ctx.console.length;
			const logMark = (await extraWebs.accessLog(web)).length;
			const eventMark = events.length;
			const started = Date.now();
			const load = { t: Date.now(), previousVersionId: activeVersionBefore(events, Date.now()) };
			const response = await ctx.page.goto(web.url, { waitUntil: 'commit', timeout: appStartTimeoutMs });
			expect([200, 304], `switch ${i}: the document's response status`).toContain(response?.status());
			await expect.poll(async () => (await extraWebs.accessLog(web)).slice(logMark).some(e => e.method === 'GET' && e.path === '/'), { timeout: 60_000, intervals: [500], message: `switch ${i}: the container logged the load's GET /` }).toBe(true);

			const lineSeen = (): boolean => ctx.console.slice(consoleMark).some(l => l.endsWith(updatedWorkerLine));
			const updatedAtNavigation = async (): Promise<boolean> => classifySelfReload(events.slice(eventMark), await extraWebs.accessLog(web), undefined, 60_000, load).outcome === 'updated-at-navigation';
			await waitFor(`switch ${i}: the reload line or the update found at navigation`, async () => ((lineSeen() || (await updatedAtNavigation())) ? true : undefined), { timeoutMs: 60_000, intervalMs: 500 }).catch(() => undefined);
			const lineTime = lineSeen() ? Date.parse(ctx.console.slice(consoleMark).find(l => l.endsWith(updatedWorkerLine))!.split(' ')[0]) : undefined;
			let label: string;
			if (lineTime === undefined) {
				const result = classifySelfReload(events.slice(eventMark), await extraWebs.accessLog(web), undefined, 60_000, load);
				if (result.outcome === 'updated-at-navigation' && (await bundleMarker(ctx.page)) === expected) {
					updated++;
					label = `N updated at navigation (${result.parts[1]})`;
				} else {
					failures.push(`${i}: unknown (${result.parts.join('; ')})`);
					label = 'unknown';
				}
			} else {
				const line = lineTime;
				const rootGets = async (): Promise<number> => (await extraWebs.accessLog(web)).filter(e => e.method === 'GET' && e.path === '/' && e.ts >= line).length;
				await waitFor(`switch ${i}: the self-reload to commit`, async () => ((events.slice(eventMark).some(e => e.kind === 'frameNavigated' && e.main === true && e.path !== 'blank' && e.t >= line) && (await rootGets()) > 0) ? true : undefined), { timeoutMs: 60_000, intervalMs: 500 }).catch(() => undefined);
				const result = classifySelfReload(events.slice(eventMark), await extraWebs.accessLog(web), line);
				if (result.outcome === 'committed') {
					committed++;
					label = `C committed in ${Math.max(...events.slice(eventMark).filter(e => e.kind === 'frameNavigated' && e.main === true && e.t >= line).map(e => e.t)) - line} ms`;
				} else if (result.outcome === 'race') {
					const reload = await userReload(ctx.page, events, () => extraWebs.accessLog(web), { timeoutMs: appStartTimeoutMs });
					if (reload.committed && (await bundleMarker(ctx.page)) === expected) {
						races++;
						label = `R L22 race; user reload committed in ${reload.ms} ms (${reload.parts[0]})`;
					} else {
						failures.push(`${i}: the user reload did not commit (${reload.parts.join('; ')})`);
						label = 'R, user reload not committed';
					}
				} else {
					failures.push(`${i}: unknown (${result.parts.join('; ')})`);
					label = 'unknown';
				}
			}
			outcomes.push(`${i} (${toB2 ? 'B2' : 'A'}): ${label}`);

			const container = (await extraWebs.accessLog(web)).slice(logMark).filter(e => e.path === '/' || e.path === '/serviceWorker.bundle.js').map(e => ({ t: e.ts, kind: 'container', method: e.method, path: e.path, status: e.status }));
			const timeline = [...events.slice(eventMark), ...container].sort((x, y) => x.t - y.t).map(e => ({ ...e, t: e.t - started }));
			await test.info().attach(`sw-timeline-${i}.json`, { body: JSON.stringify({ switch: i, bundle: toB2 ? 'B2' : 'A', outcome: label, timeline }, null, 2), contentType: 'application/json' });
		}
		await sw.stop();
		test.info().annotations.push({ type: 'sw-switches', description: `C ${committed}, R ${races}, N ${updated}, other ${6 - committed - races - updated}: ${outcomes.join('; ')}` });
		test.info().annotations.push({ type: 'sw-instrumentation', description: process.env.PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK ? 'off' : 'on' });
		expect(failures, `switches that are neither a commit nor the L22 race with a committing manual reload: ${outcomes.join('; ')}`).toEqual([]);
	});
});
