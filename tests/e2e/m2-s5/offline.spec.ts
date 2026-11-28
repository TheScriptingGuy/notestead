// M2-S5 / M2-AC15 (docs/backlog/M2.md §M2-S5; docs/test-plans/M2-S5.md): the web app reloads while the network is off.
//   M2-AC15-01  online: loaded, unlocked and synced, the service worker has cached the load; offline: one reload opens the app from
//               the worker's cache, the seeded notes are readable from the OPFS database, an edit typed offline is stored locally;
//               the web container is down (and refuses connections) for the whole offline phase, a headless sync does not have the edit; back online the web
//               sync delivers it, as the exact body, with no conflict copy
//   M2-AC15-02  NEG: with the worker's cache deleted, the offline reload fails: the offline load of -01 came from Cache Storage `v1`
// Needs the real upstream bundle: NOTESTEAD_WEB_ARTIFACT=<CI web-bundle artifact dir>.
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { syncWebThenHeadless } from '../support/flows.ts';
import { restSnapshot, compareSnapshots, snapshotProblems } from '../support/snapshot.ts';
import { NoteScreen, appStartTimeoutMs } from '../support/pages/joplinWebApp.ts';
import { swCacheKeys, swController, cacheableLoadPaths } from '../support/swState.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { expectNetworkPolicy, goOffline, goOnline, newToken, serverUnreachable, restBody, startUnlocked, typeIntoNote } from '../support/upgradeFlows.ts';
import type { Started } from '../support/upgradeFlows.ts';
import type { DownWeb } from '../support/fixtures.ts';
import { ok } from '../support/dataApi.ts';
import { syncHeadlessOnce } from '../../stack/stack.ts';

// The pages the offline reload needs, as the online load of the app requested them (plan D5), and the page the harness reads the
// OPFS database through (`/manifest.json`, localProfile.ts `openProbe`): an offline probe page is also answered by the worker, so
// it is requested once while online. That request is not an access-log entry the offline phase can see.
const waitForCacheFilled = async (s: Started): Promise<string[]> => {
	expect(await s.ctx.page.evaluate(async () => (await fetch('/manifest.json')).status), 'the probe page is available online').toBe(200);
	await expect.poll(async () => (await swCacheKeys(s.ctx.page)).includes('/manifest.json'), { timeout: 60_000, intervals: [500], message: 'the probe page is in Cache Storage v1' }).toBe(true);
	let missing: string[] = [];
	await expect.poll(async () => {
		const wanted = cacheableLoadPaths(s.ctx.network.entries(), s.origin);
		const have = new Set(await swCacheKeys(s.ctx.page));
		missing = wanted.filter(p => !have.has(p));
		return missing;
	}, { timeout: 60_000, intervals: [1_000], message: 'Cache Storage `v1` holds every cacheable path of the online load' }).toEqual([]);
	return cacheableLoadPaths(s.ctx.network.entries(), s.origin);
};

const mainScreenAfterOnlineLoad = async (s: Started): Promise<string[]> => {
	await s.app.openFolder(s.seedFolder);
	for (const n of s.notes) await expect(s.app.noteInList(n.title), `seeded note ${n.id} is listed`).toBeVisible();
	await expect.poll(() => swController(s.ctx.page), { timeout: 60_000, message: 'the service worker controls the page' }).not.toBeNull();
	const cached = await waitForCacheFilled(s);
	for (const required of ['/', '/app.bundle.js', '/environment.js', '/serviceWorker.bundle.js']) expect(cached, `the online load requested and cached ${required}`).toContain(required);
	expect(cached.some(p => p.endsWith('.wasm')), 'a .wasm file is among the cached paths').toBe(true);
	return cached;
};

test.describe('M2-S5 offline reload', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });
	test.use({ e2eeSeed: { notes: 3 } });

	test('M2-AC15-01 offline, a reload opens the app from the service-worker cache with the notes readable, and an offline edit syncs once online', async ({ stack, e2eeAccount, headlessService, dataApi, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const s = await startUnlocked({ stack, e2eeAccount, extraWebs, appContexts, testBundles }, 'off');
		const { app, ctx } = s;
		const note1 = s.notes[0];
		const token = newToken();
		let seedSnapshot = restSnapshot(dataApi);

		await test.step('online: the app is loaded and synced, the service worker has cached the load', async () => {
			await syncWebThenHeadless(app, ctx.network, stack, headlessService);
			seedSnapshot = restSnapshot(dataApi);
			const cached = await mainScreenAfterOnlineLoad(s);
			test.info().annotations.push({ type: 'cache', description: `${cached.length} paths cached: ${cached.slice(0, 12).join(' ')}${cached.length > 12 ? ' …' : ''}` });
		});

		const fx = { stack, e2eeAccount, extraWebs, appContexts, testBundles };
		let down: DownWeb | undefined;
		const guards: string[] = [];
		await test.step('go offline: quiesce, the web container down, the context offline', async () => {
			down = await goOffline(fx, s);
			guards.push(await serverUnreachable(down));
		});
		if (!down) throw new Error('unreachable');

		await test.step('offline: one reload opens the app from the worker\'s cache', async () => {
			const response = await ctx.page.reload({ timeout: appStartTimeoutMs });
			expect(response?.fromServiceWorker(), 'the document came from the service worker').toBe(true);
			await expect(app.sidebarButton(), 'the main screen opens offline').toBeVisible({ timeout: appStartTimeoutMs });
			expect(await ctx.page.evaluate(() => (globalThis as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated), 'cross-origin isolated offline (OPFS SQLite needs it)').toBe(true);
			guards.push(await serverUnreachable(down!));
		});

		await test.step('offline: the seeded notes are readable from the OPFS database', async () => {
			await app.openFolder(s.seedFolder);
			for (const n of s.notes) await expect(app.noteInList(n.title), `seeded note ${n.id} is listed offline`).toBeVisible();
			await app.openNote(note1.title);
			await new NoteScreen(ctx.page).waitOpen();
			await expect.poll(async () => ((await app.frameText()).includes(note1.body) ? 'shown' : 'not shown'), { timeout: 60_000, intervals: [500], message: 'seeded note 1\'s body is shown offline' }).toBe('shown');
			await app.backToList();
		});

		await test.step('offline: an edit typed like a user is stored in the local database', async () => {
			await typeIntoNote(s, note1.title, token, 'the offline edit');
		});

		await test.step('control: a headless sync does not have the offline edit, and the server is still unreachable', async () => {
			await syncHeadlessOnce(stack, headlessService);
			expect(restBody(dataApi, note1.id).includes(token), 'REST does not have the offline edit yet').toBe(false);
			guards.push(await serverUnreachable(down!));
			test.info().annotations.push({ type: 'offline-guard', description: `${guards.length} refused connects (${guards.join(', ')})` });
		});

		await test.step('online again: the web sync delivers the offline edit as the exact body, with no conflict copy', async () => {
			await goOnline(fx, s, down!, { mountDist: testBundles.a });
			await syncWebThenHeadless(app, ctx.network, stack, headlessService);
			await expect.poll(() => restBody(dataApi, note1.id), { timeout: 60_000, intervals: [1_000] }).toBe(`${note1.body} ${token}`);
			const note = ok(dataApi.get(`/notes/${note1.id}?fields=id,is_conflict`), 'GET /notes/:id');
			expect(note.is_conflict).toBe(0);
			const problems = snapshotProblems(compareSnapshots(seedSnapshot, restSnapshot(dataApi)), { changed: [{ id: note1.id, fields: ['body', 'updated_time'] }] });
			expect(problems, 'the account changed only by the offline edit (no conflict copy, nothing added or lost)').toEqual([]);
		});

		expectNetworkPolicy(s);
	});

	test('M2-AC15-02 NEG without the worker\'s cache the offline reload fails', async ({ stack, e2eeAccount, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const s = await startUnlocked({ stack, e2eeAccount, extraWebs, appContexts, testBundles }, 'neg');
		const { ctx } = s;
		let down: DownWeb | undefined;

		await test.step('online: the same load, the cache is filled', async () => {
			await mainScreenAfterOnlineLoad(s);
		});

		await test.step('the worker\'s cache is deleted, then the web container goes down and the context offline', async () => {
			expect(await ctx.page.evaluate(() => (globalThis as unknown as { caches: { delete: (n: string) => Promise<boolean> } }).caches.delete('v1')), 'Cache Storage v1 existed and was deleted').toBe(true);
			down = await goOffline({ stack, e2eeAccount, extraWebs, appContexts, testBundles }, s);
			await serverUnreachable(down);
			const pages = (await swCacheKeys(ctx.page)).filter(p => p === '/' || p === '/index.html');
			expect(pages, 'the cache holds neither page entry (only /manifest.json was put back for the probe page)').toEqual([]);
		});

		await test.step('offline: the reload is rejected', async () => {
			const error = await ctx.page.reload({ timeout: appStartTimeoutMs }).then(() => undefined, (e: Error) => e);
			expect(error, 'the offline reload rejects (the app must not load from the HTTP cache)').toBeDefined();
			expect(error?.message).toMatch(/net::ERR_(INTERNET_DISCONNECTED|FAILED|CONNECTION_REFUSED)/);
			test.info().annotations.push({ type: 'offline-reload-error', description: error?.message.split('\n')[0] ?? '' });
			await serverUnreachable(down!);
		});

		expectNetworkPolicy(s);
	});
});
