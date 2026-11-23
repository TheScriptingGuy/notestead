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
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { waitFor } from '../../support/poll.ts';
import { freePort } from '../../stack/stack.ts';

interface Stamped { t: number; kind: string; detail: Record<string, unknown> }

const updatedLine = 'Reloading page to make use of updated COOP/COEP Service Worker.';
const pathOf = (url: string): string => {
	try {
		return new URL(url).pathname || url;
	} catch {
		return url;
	}
};

test.describe('M2-S5 harness: service-worker update reload', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('H-SWU-01 six switches that change the worker each end in the page\'s own reload committing', async ({ stack, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const port = await freePort();
		let web = await extraWebs.start({ role: 'web-extra', port, mountDist: testBundles.a });
		const ctx = await appContexts.open(web.url, 'swu');
		const app = new JoplinWebApp(ctx.page);
		await app.open(web.url);

		const events: Stamped[] = [];
		const cdp = await ctx.context.newCDPSession(ctx.page);
		const record = (kind: string, detail: Record<string, unknown>): void => { events.push({ t: Date.now(), kind, detail }); };
		cdp.on('ServiceWorker.workerVersionUpdated', (e: { versions: { versionId: string; scriptURL: string; status: string; runningStatus: string }[] }) => {
			for (const v of e.versions) record('workerVersionUpdated', { versionId: v.versionId, script: pathOf(v.scriptURL), status: v.status, runningStatus: v.runningStatus });
		});
		cdp.on('Page.frameRequestedNavigation', (e: { frameId: string; reason: string; url: string }) => record('frameRequestedNavigation', { frameId: e.frameId, reason: e.reason, url: pathOf(e.url) }));
		cdp.on('Page.frameStartedLoading', (e: { frameId: string }) => record('frameStartedLoading', { frameId: e.frameId }));
		cdp.on('Page.frameNavigated', (e: { frame: { id: string; loaderId: string; url: string; parentId?: string } }) => record('frameNavigated', { frameId: e.frame.id, loaderId: e.frame.loaderId, url: pathOf(e.frame.url), main: e.frame.parentId === undefined }));
		cdp.on('Page.frameStoppedLoading', (e: { frameId: string }) => record('frameStoppedLoading', { frameId: e.frameId }));
		await cdp.send('ServiceWorker.enable');
		await cdp.send('Page.enable');

		const outcomes: string[] = [];
		const hung: number[] = [];
		for (let i = 1; i <= 6; i++) {
			const toB2 = i % 2 === 1;
			const expected = toB2 ? `B2-${testBundles.nonce}` : null;
			await ctx.page.goto('about:blank');
			web = await extraWebs.redeploy(web, { mountDist: toB2 ? testBundles.b2 : testBundles.a });
			const consoleMark = ctx.console.length;
			const logMark = (await extraWebs.accessLog(web)).length;
			const eventMark = events.length;
			const started = Date.now();
			await ctx.page.goto(web.url, { timeout: appStartTimeoutMs });

			let lineAt: number | undefined;
			try {
				await waitFor(`switch ${i}: the updated-worker reload line`, async () => (ctx.console.slice(consoleMark).some(l => l.endsWith(updatedLine)) ? true : undefined), { timeoutMs: 60_000, intervalMs: 250 });
				lineAt = Date.now();
			} catch {
				lineAt = undefined;
			}
			let committedMs: number | undefined;
			if (lineAt !== undefined) {
				const after = lineAt;
				try {
					await waitFor(`switch ${i}: a main-frame navigation committed after the line`, async () => {
						const navigated = events.slice(eventMark).some(e => e.kind === 'frameNavigated' && e.detail.main === true && e.t >= after - 50 && !String(e.detail.url).startsWith('blank'));
						if (!navigated) return undefined;
						try {
							return (await bundleMarker(ctx.page)) === expected ? true : undefined;
						} catch {
							return undefined;
						}
					}, { timeoutMs: 60_000, intervalMs: 500 });
					committedMs = Date.now() - after;
				} catch {
					committedMs = undefined;
				}
			}
			if (committedMs === undefined) hung.push(i);
			outcomes.push(`${i} (${toB2 ? 'B2' : 'A'}): ${committedMs === undefined ? `hung${lineAt === undefined ? ' (no reload line)' : ''}` : `committed in ${committedMs} ms`}`);

			const container = (await extraWebs.accessLog(web)).slice(logMark).filter(e => e.path === '/' || e.path === '/serviceWorker.bundle.js').map(e => ({ t: e.ts, kind: 'container', detail: { method: e.method, path: e.path, status: e.status } }));
			const consoleLines = ctx.console.slice(consoleMark).filter(l => l.includes('Reloading page to make use of')).map(l => ({ t: Date.parse(l.split(' ')[0]), kind: 'console', detail: { line: l.split('] ')[1] ?? l } }));
			const timeline = [...events.slice(eventMark), ...container, ...consoleLines].sort((a, b) => a.t - b.t).map(e => ({ ms: e.t - started, kind: e.kind, ...e.detail }));
			await test.info().attach(`sw-timeline-${i}.json`, { body: JSON.stringify({ switch: i, bundle: toB2 ? 'B2' : 'A', outcome: outcomes[outcomes.length - 1], timeline }, null, 2), contentType: 'application/json' });
		}
		test.info().annotations.push({ type: 'sw-switches', description: outcomes.join('; ') });
		test.info().annotations.push({ type: 'sw-instrumentation', description: process.env.PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK ? 'off' : 'on' });
		expect(hung, `switches whose self-reload never committed: ${outcomes.join('; ')}`).toEqual([]);
	});
});
