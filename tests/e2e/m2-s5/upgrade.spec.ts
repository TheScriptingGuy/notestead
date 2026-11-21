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
import { bundleMarker, swCachedDigest, swController } from '../support/swState.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { expectNetworkPolicy, newToken, restBody, startUnlocked, typeIntoNote } from '../support/upgradeFlows.ts';
import type { Fixtures, Started } from '../support/upgradeFlows.ts';
import type { DataApi } from '../support/fixtures.ts';
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

		await test.step('with bundle A: edit Y in note 2, stored locally only; snapshot S0', async () => {
			await typeIntoNote(s, note2.title, y, 'the local-only edit Y');
			expect(restBody(dataApi, note2.id).includes(y), 'Y exists only in the local profile').toBe(false);
		});
		const s0 = restSnapshot(dataApi);

		await test.step('control: the worker controls the page, runs bundle A, and has A\'s app bundle cached', async () => {
			await expect.poll(() => swController(ctx.page), { timeout: 60_000 }).not.toBeNull();
			expect(await bundleMarker(ctx.page), 'bundle A has no marker').toBeNull();
			await expect.poll(async () => (await swCachedDigest(ctx.page, '/app.bundle.js'))?.sha256, { timeout: 60_000, intervals: [1_000], message: 'the cache holds A\'s app bundle' }).toBe(entryOf(testBundles.manifests.a, 'app.bundle.js'));
		});

		let consoleMark = 0;
		let logMark = 0;
		await test.step(`redeploy web with bundle ${which} on the same port, then one online reload`, async () => {
			const redeployed = await extraWebs.redeploy(web, { mountDist: target });
			expect(redeployed.url, 'the same origin').toBe(web.url);
			expect(await bundleMarker(ctx.page), 'before the reload the running page is still bundle A').toBeNull();
			consoleMark = ctx.console.length;
			logMark = (await extraWebs.accessLog(redeployed)).length;
			s.web = redeployed;
			await ctx.page.reload({ timeout: appStartTimeoutMs });
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
			await test.step('control: upstream reloaded the page itself for the updated service worker', async () => {
				const updated = 'Reloading page to make use of updated COOP/COEP Service Worker.';
				const plain = 'Reloading page to make use of COOP/COEP Service Worker.';
				await expect.poll(() => ctx.console.slice(consoleMark).some(l => l.endsWith(updated)), { timeout: 60_000, intervals: [1_000], message: 'the console shows upstream\'s updated-worker reload line' }).toBe(true);
				const after = ctx.console.slice(consoleMark);
				test.info().annotations.push({ type: 'self-reloads', description: `updated-worker lines ${after.filter(l => l.endsWith(updated)).length}, not-controlling lines ${after.filter(l => l.endsWith(plain)).length}` });
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
