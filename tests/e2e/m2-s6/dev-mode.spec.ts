// M2-AC13 (docs/test-plans/M2-S6.md): the overlaid bundle runs with __DEV__ === false even on a localhost origin, where upstream's
// own environment.js turns dev mode on. One origin, http://localhost:<P>, serves in turn the overlaid bundle (the image under test)
// and the un-overlaid one (the same image with upstream's files mounted), each to a fresh browser context (own OPFS, own service
// worker). The positive phase runs the real app and reads dev mode beyond the flag (F2): no window.joplin, our title, the production
// database file, no page error. The negative phase never opens the app (RU-1): upstream's production bundle crashes at start in dev
// mode (a React Refresh stub throws), so it asserts window.__DEV__ === true and the title "Joplin DEV" on the same origin, then the
// crash itself as proof that dev mode was entered.
import { freePort } from '../../stack/stack.ts';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import type { AppContext } from '../support/fixtures.ts';
import { opfsPaths } from '../support/localProfile.ts';
import { endOfTestViolations } from '../support/network.ts';
import { JoplinWebApp, appStartTimeoutMs } from '../support/pages/joplinWebApp.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { waitFor } from '../../support/poll.ts';
import { productName } from '../../support/branding.ts';

const reactRefreshError = '[pageerror] React Refresh runtime should not be included in the production bundle.';

interface DevFacts { origin: string; dev: unknown; hasJoplin: boolean; env: unknown; title: string }

const readFacts = (app: AppContext): Promise<DevFacts> => app.page.evaluate(() => {
	const g = globalThis as unknown as { location: { origin: string }; __DEV__?: unknown; joplin?: { Setting?: { value?: (key: string) => unknown } }; document: { title: string } };
	return { origin: g.location.origin, dev: g.__DEV__, hasJoplin: 'joplin' in g, env: g.joplin?.Setting?.value?.('env'), title: g.document.title };
});

test.describe('M2-AC13 dev mode follows the bundle, not the origin', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC13-01 __DEV__ is false on localhost with the overlay, and true on the same origin without it', async ({ stack, extraWebs, appContexts, unoverlaidDist }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		const port = await freePort();
		const origin = `http://localhost:${port}`;

		// POS: the image's own bundle
		const overlaid = await extraWebs.start({ role: 'web-extra', port });
		const pos = await appContexts.open(origin, 'pos');
		await new JoplinWebApp(pos.page).open(origin);
		const posFacts = await readFacts(pos);
		expect(pos.console.filter(l => l.includes('[pageerror]')), 'the overlaid bundle starts without a page error on the localhost origin').toEqual([]);
		expect(posFacts.origin).toContain('localhost');
		expect(posFacts.dev, 'window.__DEV__ with the overlay').toBe(false);
		expect(posFacts.hasJoplin, '"joplin" in window: upstream exposes it in dev mode only').toBe(false);
		await expect.poll(async () => (await readFacts(pos)).title, { message: 'document.title with the overlay' }).toBe(productName);
		expect(endOfTestViolations(pos.network.entries(), origin, pos.network.allowed()), 'network policy on the localhost origin').toEqual([]);
		const posPaths = await opfsPaths(pos);
		expect(posPaths, 'the production database file').toContain('/joplin.sqlite.sqlite3');
		expect(posPaths.filter(p => p.includes('-20240127-1')), 'no dev-mode database file').toEqual([]);
		expect(pos.console.filter(l => l.includes('[pageerror]')), 'no page error up to the end of the positive phase').toEqual([]);
		await appContexts.close(pos);
		extraWebs.stop(overlaid);

		// NEG: the same origin, upstream's files. Upstream's production bundle crashes at start in dev mode (RU-1: it requires the
		// react-refresh runtime, which a production build stubs with a throw), so the app is never opened: only what environment.js
		// and the first scripts do is asserted, then the crash itself as the proof that dev mode was really entered.
		const unoverlaid = await extraWebs.start({ role: 'web-unoverlaid', port, mountDist: unoverlaidDist.unoverlaid });
		expect(unoverlaid.url, 'the same host and port').toBe(`http://127.0.0.1:${port}`);
		const neg = await appContexts.open(origin, 'neg');
		neg.allowSqliteFailures('M2-AC13 NEG: upstream\'s production bundle crashes at start in dev mode (react-refresh stub), so its database and page errors are not the product (RU-1)');
		await neg.page.goto(`${origin}/`);
		await waitFor('the page to be complete and controlled by the service worker', async () => {
			try {
				return await neg.page.evaluate(() => {
					const g = globalThis as unknown as { document: { readyState: string }; navigator: { serviceWorker?: { controller: unknown } } };
					return g.document.readyState === 'complete' && !!g.navigator.serviceWorker?.controller ? true : undefined;
				});
			} catch {
				return undefined; // the service worker's reload is navigating the page
			}
		}, { timeoutMs: appStartTimeoutMs, intervalMs: 250 });
		const negFacts = await readFacts(neg);
		expect(negFacts.origin, 'the same origin as the positive phase').toBe(posFacts.origin);
		expect(negFacts.dev, 'window.__DEV__ without the overlay').toBe(true);
		expect(negFacts.title, 'document.title without the overlay').toBe('Joplin DEV');
		await expect.poll(() => neg.console.some(l => l.endsWith(reactRefreshError)), { timeout: 60_000, message: 'the un-overlaid bundle entered upstream\'s dev path (React Refresh pageerror)' }).toBe(true);
		const negPaths = await opfsPaths(neg).catch((error: Error) => [`(unreadable: ${error.message})`]);
		test.info().annotations.push({ type: 'neg-opfs', description: JSON.stringify(negPaths) });
		test.info().annotations.push({ type: 'origins', description: JSON.stringify({ pos: posFacts.origin, neg: negFacts.origin }) });
	});
});
