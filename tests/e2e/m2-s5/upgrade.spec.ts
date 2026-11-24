// M2-S5 / M2-AC16 (docs/backlog/M2.md §M2-S5; docs/test-plans/M2-S5.md): a redeployed `web` serves the new bundle after one online
// reload, and the local profile (OPFS) opens with the data intact.
//   M2-AC16-01  loaded with bundle A and synced; `web` redeployed on the same port with bundle B (a changed app bundle and environment
//               file); one online reload: B runs (its marker), the worker's cache holds B's app bundle, the profile opens, a local-only
//               edit made before the redeploy is still there, and the data comparison against REST finds nothing but that edit
//   M2-AC16-03  the same with B2, which also changes the service worker: upstream reloads the page itself for the updated worker
// Needs the real upstream bundle: NOTESTEAD_WEB_ARTIFACT=<CI web-bundle artifact dir>.
import { requireUpstreamBundle } from '../support/bundle.ts';
import { ok } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { syncWebThenHeadless } from '../support/flows.ts';
import { NoteScreen, appStartTimeoutMs } from '../support/pages/joplinWebApp.ts';
import { compareSnapshots, restSnapshot, snapshotProblems } from '../support/snapshot.ts';
import { activeVersionBefore, classifySelfReload, recordSwTimeline, updatedWorkerLine, userReload } from '../support/swTimeline.ts';
import { bundleMarker, swCachedDigest, swController } from '../support/swState.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { expectNetworkPolicy, expectOnlyReadiness, goOffline, goOnline, newToken, restBody, serverUnreachable, startUnlocked, typeIntoNote } from '../support/upgradeFlows.ts';
import type { Fixtures, Started } from '../support/upgradeFlows.ts';
import type { DataApi, DownWeb } from '../support/fixtures.ts';
import { waitFor } from '../../support/poll.ts';
import { syncHeadlessOnce } from '../../stack/stack.ts';
import type { HeadlessService } from '../../stack/stack.ts';

interface UpgradeFixtures extends Fixtures {
	headlessService: HeadlessService;
	dataApi: DataApi;
}

const startupFailures = (lines: string[]): string[] => lines.filter(l => l.includes('Startup failure'));

test.describe('M2-S5 bundle upgrade', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });
	test.use({ e2eeSeed: { notes: 2 } });

	const upgrade = async (fx: UpgradeFixtures, which: 'B' | 'B2'): Promise<void> => {
		const { stack, e2eeAccount, headlessService, dataApi, extraWebs, appContexts, testBundles } = fx;
		await requireUpstreamBundle(stack, 'M2-S5');
		const target = which === 'B' ? testBundles.b : testBundles.b2;
		const targetManifest = which === 'B' ? testBundles.manifests.b : testBundles.manifests.b2;
		const expectedMarker = `${which}-${testBundles.nonce}`;
		const s: Started = await startUnlocked({ stack, e2eeAccount, extraWebs, appContexts, testBundles }, 'up');
		const { app, ctx, web } = s;
		const [note1, note2] = s.notes;
		const x = newToken();
		const y = newToken();
		const entryOf = (m: typeof targetManifest, path: string): string | undefined => m.files.find(f => f.path === path)?.sha256;

		await test.step('with bundle A: edit X in note 1 and sync (B2: one sync with A only)', async () => {
			if (which === 'B') {
				await typeIntoNote(s, note1.title, x, 'edit X');
				await syncWebThenHeadless(app, ctx.network, stack, headlessService);
				await expect.poll(() => restBody(dataApi, note1.id), { timeout: 60_000, intervals: [1_000] }).toBe(`${note1.body} ${x}`);
			} else {
				await syncWebThenHeadless(app, ctx.network, stack, headlessService);
			}
		});

		let down: DownWeb | undefined;
		await test.step('go offline (RU-1, RU-2): quiesce, the web container down, the context offline', async () => {
			down = await goOffline(fx, s);
			await serverUnreachable(down);
		});
		if (!down) throw new Error('unreachable');

		await test.step('offline: edit Y in note 2, stored locally; a headless sync does not have it (RU-1 control)', async () => {
			await typeIntoNote(s, note2.title, y, 'the local-only edit Y');
			await syncHeadlessOnce(stack, headlessService);
			expect(restBody(dataApi, note2.id).includes(y), 'REST lacks Y: it never reached the server').toBe(false);
		});
		const s0 = restSnapshot(dataApi);

		await test.step('control: the worker controls the page, runs bundle A, and has A\'s app bundle cached', async () => {
			await expect.poll(() => swController(ctx.page), { timeout: 60_000 }).not.toBeNull();
			expect(await bundleMarker(ctx.page), 'bundle A has no marker').toBeNull();
			await expect.poll(async () => (await swCachedDigest(ctx.page, '/app.bundle.js'))?.sha256, { timeout: 60_000, intervals: [1_000], message: 'the cache holds A\'s app bundle' }).toBe(entryOf(testBundles.manifests.a, 'app.bundle.js'));
		});

		let consoleMark = 0;
		let logMark = 0;
		let sw: Awaited<ReturnType<typeof recordSwTimeline>> | undefined;
		let loadT = 0;
		await test.step(`unload the tab offline, bring web back with bundle ${which} on the same port, then one online load (RU-1, I8)`, async () => {
			await ctx.page.goto('about:blank');
			const redeployed = await goOnline(fx, s, down!, { mountDist: target });
			expect(redeployed.url, 'the same origin').toBe(web.url);
			logMark = await expectOnlyReadiness(extraWebs, redeployed);
			consoleMark = ctx.console.length;
			if (which === 'B2') sw = await recordSwTimeline(ctx.page);
			loadT = Date.now();
			const response = await ctx.page.goto(redeployed.url, { waitUntil: 'commit', timeout: appStartTimeoutMs });
			expect([200, 304], 'the document\'s response status').toContain(response?.status());
			await expect.poll(async () => (await extraWebs.accessLog(redeployed)).slice(logMark).some(e => e.method === 'GET' && e.path === '/'), { timeout: 60_000, intervals: [500], message: 'the container logged the load\'s GET /' }).toBe(true);
		});

		await test.step(`bundle ${which} is served: it runs, its app bundle is cached, its files were fetched`, async () => {
			await expect.poll(() => bundleMarker(ctx.page), { timeout: appStartTimeoutMs, intervals: [500], message: `the page runs bundle ${which}` }).toBe(expectedMarker);
			const wanted = entryOf(targetManifest, 'app.bundle.js');
			expect(wanted).not.toBe(entryOf(testBundles.manifests.a, 'app.bundle.js'));
			await expect.poll(async () => (await swCachedDigest(ctx.page, '/app.bundle.js'))?.sha256, { timeout: 60_000, intervals: [1_000], message: 'the worker cached the new app bundle' }).toBe(wanted);
			const log = (await extraWebs.accessLog(s.web)).slice(logMark);
			for (const path of which === 'B' ? ['/app.bundle.js', '/environment.js'] : ['/app.bundle.js', '/environment.js', '/serviceWorker.bundle.js']) {
				expect(log.some(e => e.method === 'GET' && e.path === path && e.status === 200), `the new container served GET ${path} with 200 after the reload`).toBe(true);
			}
		});

		if (which === 'B2') {
			await test.step('the worker was updated: upstream\'s self-reload committed, the documented L22 race, or the update found at navigation (RU-13, RU-17)', async () => {
				const plain = 'Reloading page to make use of COOP/COEP Service Worker.';
				const events = sw!.events;
				const load = { t: loadT, previousVersionId: activeVersionBefore(events, loadT) };
				const lines = (): string[] => ctx.console.slice(consoleMark).filter(l => l.endsWith(updatedWorkerLine));
				const updatedAtNavigation = async (): Promise<boolean> => classifySelfReload(events, await extraWebs.accessLog(s.web), undefined, 60_000, load).outcome === 'updated-at-navigation';
				await waitFor('the updated-worker reload line, or the update found at navigation', async () => ((lines().length > 0 || (await updatedAtNavigation())) ? true : undefined), { timeoutMs: 60_000, intervalMs: 500 }).catch(() => undefined);
				const after = ctx.console.slice(consoleMark);
				test.info().annotations.push({ type: 'self-reloads', description: `updated-worker lines ${lines().length}, not-controlling lines ${after.filter(l => l.endsWith(plain)).length}` });
				if (lines().length === 0) {
					const entries = await extraWebs.accessLog(s.web);
					const result = classifySelfReload(events, entries, undefined, 60_000, load);
					await test.info().attach('sw-timeline.json', { body: JSON.stringify({ outcome: result.outcome, parts: result.parts, timeline: events.map(e => ({ ...e, t: e.t - loadT })), container: entries.filter(e => e.path === '/' || e.path === '/serviceWorker.bundle.js') }, null, 2), contentType: 'application/json' });
					expect(result.outcome, `no reload line, and not the update found at navigation: ${result.parts.join('; ')}`).toBe('updated-at-navigation');
					test.info().annotations.push({ type: 'self-reload', description: `N updated at navigation (${result.parts[1]})` });
				} else {
					const lineTime = Date.parse(lines()[0].split(' ')[0]);
					const rootGets = async (from: number): Promise<number> => (await extraWebs.accessLog(s.web)).filter(e => e.method === 'GET' && e.path === '/' && e.ts >= from).length;
					// a commit shows within seconds; the race is only claimed after a full 60 s without one
					await waitFor('the self-reload to commit', async () => ((events.some(e => e.kind === 'frameNavigated' && e.main === true && e.path !== 'blank' && e.t >= lineTime) && (await rootGets(lineTime)) > 0) ? true : undefined), { timeoutMs: 60_000, intervalMs: 500 }).catch(() => undefined);
					const entries = await extraWebs.accessLog(s.web);
					const result = classifySelfReload(events, entries, lineTime);
					await test.info().attach('sw-timeline.json', { body: JSON.stringify({ outcome: result.outcome, parts: result.parts, timeline: events.map(e => ({ ...e, t: e.t - lineTime })), container: entries.filter(e => e.ts >= lineTime - 1_000 && (e.path === '/' || e.path === '/serviceWorker.bundle.js')).map(e => ({ ...e, ts: e.ts - lineTime })) }, null, 2), contentType: 'application/json' });
					expect(lines(), 'exactly one updated-worker reload line').toHaveLength(1);
					expect(result.outcome, `the hang does not match L22, or is not a commit: ${result.parts.join('; ')}`).not.toBe('unknown');
					if (result.outcome === 'committed') {
						test.info().annotations.push({ type: 'self-reload', description: `C committed in ${Math.max(...events.filter(e => e.kind === 'frameNavigated' && e.main === true && e.t >= lineTime).map(e => e.t)) - lineTime} ms` });
					} else {
						const reload = await userReload(ctx.page, events, () => extraWebs.accessLog(s.web), { timeoutMs: appStartTimeoutMs });
						test.info().annotations.push({ type: 'user-reload', description: reload.parts.join('; ') });
						expect(reload.committed, `the user's reload of the stuck tab committed: ${reload.parts.join('; ')}`).toBe(true);
						test.info().annotations.push({ type: 'self-reload', description: `R L22 race; manual reload committed in ${reload.ms} ms` });
					}
				}
				await sw!.stop();
				await expect.poll(() => bundleMarker(ctx.page), { timeout: appStartTimeoutMs, intervals: [500] }).toBe(expectedMarker);
			});
		}

		await test.step('the local profile opens: no sync wizard, no startup error, the notes are listed, Y is there', async () => {
			await expect(app.sidebarButton()).toBeVisible({ timeout: appStartTimeoutMs });
			await expect(app.syncWizard(), 'no sync wizard: the profile was not recreated').toHaveCount(0);
			await expect(ctx.page.getByText('Startup error.', { exact: true })).toHaveCount(0);
			await app.openFolder(s.seedFolder);
			for (const n of s.notes) await expect(app.noteInList(n.title), `seeded note ${n.id} is listed`).toBeVisible();
			await app.openNote(note2.title);
			await new NoteScreen(ctx.page).waitOpen();
			await expect.poll(async () => ((await app.frameText()).includes(y) ? 'shown' : 'not shown'), { timeout: 60_000, intervals: [500], message: 'note 2 shows the local-only edit Y' }).toBe('shown');
			await app.backToList();
			expect(startupFailures(ctx.console.slice(consoleMark)), 'no startup failure after the reload').toEqual([]);
		});

		await test.step('data intact: Y syncs, and nothing else differs from S0', async () => {
			await syncWebThenHeadless(app, ctx.network, stack, headlessService);
			await expect.poll(() => restBody(dataApi, note2.id), { timeout: 60_000, intervals: [1_000] }).toBe(`${note2.body} ${y}`);
			expect(ok(dataApi.get(`/notes/${note2.id}?fields=id,is_conflict`), 'GET /notes/:id').is_conflict).toBe(0);
			const problems = snapshotProblems(compareSnapshots(s0, restSnapshot(dataApi)), { changed: [{ id: note2.id, fields: ['body', 'updated_time'] }] });
			expect(problems, 'the account changed only by edit Y (nothing lost, no conflict copy, nothing added)').toEqual([]);
		});

		expectNetworkPolicy(s);
	};

	test('M2-AC16-01 after a redeploy with a new bundle one online reload serves it, the local profile opens and the data is intact', async ({ stack, e2eeAccount, headlessService, dataApi, extraWebs, appContexts, testBundles }) => {
		await upgrade({ stack, e2eeAccount, headlessService, dataApi, extraWebs, appContexts, testBundles }, 'B');
	});

	test('M2-AC16-03 the same upgrade when the new bundle also changes the service worker', async ({ stack, e2eeAccount, headlessService, dataApi, extraWebs, appContexts, testBundles }) => {
		await upgrade({ stack, e2eeAccount, headlessService, dataApi, extraWebs, appContexts, testBundles }, 'B2');
	});
});
