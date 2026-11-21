// M2-S5 / M2-AC16 NEG (docs/backlog/M2.md §M2-S5; docs/test-plans/M2-S5.md): a bundle whose database version is lower than the profile's
// is refused by upstream's version check, and the rollback runbook's "clear site data and re-sync" recovers everything that was synced.
//   M2-AC16-02  loaded with A and synced (the runbook's step 1), an unsynced edit Z typed; `web` redeployed with bundle O (A without its
//               newest migration); one reload: upstream refuses the profile with its alert and `Startup error.`, the local profile is
//               untouched (Z is still in it); clear site data, open the app, sign in, enter the master password, sync: every synced
//               note and notebook is back, Z is gone (it was never synced), and the account gained nothing but upstream's welcome notebook
// Needs the real upstream bundle: NOTESTEAD_WEB_ARTIFACT=<CI web-bundle artifact dir>.
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { configureJoplinServerSync, firstSyncTimeoutMs, syncWebOnce, syncWebThenHeadless } from '../support/flows.ts';
import { clearSiteData, findInDatabaseFile, localDatabaseFiles } from '../support/localProfile.ts';
import { JoplinWebApp, NoteScreen, appStartTimeoutMs } from '../support/pages/joplinWebApp.ts';
import { parseProfileRefusal } from '../support/profileRefusal.ts';
import { compareSnapshots, restSnapshot, snapshotProblems } from '../support/snapshot.ts';
import { bundleMarker } from '../support/swState.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { expectNetworkPolicy, newToken, restBody, startUnlocked, typeIntoNote } from '../support/upgradeFlows.ts';
import { syncHeadlessOnce } from '../../stack/stack.ts';
import { holdsFor } from '../../support/poll.ts';

test.describe('M2-S5 downgrade refusal and recovery', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });
	test.use({ e2eeSeed: { notes: 2 } });

	test('M2-AC16-02 NEG an older bundle with a lower database version is refused, and clear site data and re-sync recovers all synced data', async ({ stack, e2eeAccount, headlessService, dataApi, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const s = await startUnlocked({ stack, e2eeAccount, extraWebs, appContexts, testBundles }, 'down');
		const { app, ctx, web } = s;
		const [note1, note2] = s.notes;
		const { versions } = testBundles;
		const x = newToken();
		const z = newToken();

		await test.step('runbook step 1, sync first: edit X in note 1, sync, REST has X; snapshot S0', async () => {
			await typeIntoNote(s, note1.title, x, 'edit X');
			await syncWebThenHeadless(app, ctx.network, stack, headlessService);
			await expect.poll(() => restBody(dataApi, note1.id), { timeout: 60_000, intervals: [1_000] }).toBe(`${note1.body} ${x}`);
		});
		const s0 = restSnapshot(dataApi);

		await test.step('an unsynced edit Z in note 2, stored locally only', async () => {
			await typeIntoNote(s, note2.title, z, 'the unsynced edit Z');
			expect(restBody(dataApi, note2.id).includes(z), 'Z exists only in the local profile').toBe(false);
		});

		await test.step('roll back: redeploy web with the older bundle O, one reload', async () => {
			ctx.expectProfileRefusal('M2-AC16-02: the downgrade to bundle O is refused by upstream (plan F1, D6)');
			s.web = await extraWebs.redeploy(web, { mountDist: testBundles.o });
			await ctx.page.reload({ timeout: appStartTimeoutMs });
		});

		await test.step('refusal: upstream\'s alert names both versions, the page shows Startup error., nothing opens', async () => {
			await expect.poll(() => ctx.dialogs.some(d => parseProfileRefusal(d.message) !== undefined), { timeout: appStartTimeoutMs, intervals: [500], message: 'upstream\'s profile-version alert arrived' }).toBe(true);
			const dialog = ctx.dialogs.find(d => parseProfileRefusal(d.message) !== undefined);
			expect(dialog?.message.startsWith('Something went wrong while starting the application: Error: Unknown profile version.')).toBe(true);
			expect(parseProfileRefusal(dialog?.message ?? '')).toEqual({ profile: versions.latest, expected: versions.latest - 1 });
			await expect(ctx.page.getByText('Startup error.', { exact: true })).toBeVisible({ timeout: 60_000 });
			expect(await bundleMarker(ctx.page), 'the refused page runs bundle O').toBe(`O-${testBundles.nonce}`);
			await holdsFor('the app stays refused', async () => {
				if ((await app.syncWizard().count()) > 0) return 'the sync wizard is shown';
				if ((await app.sidebarButton().count()) > 0) return 'the note list is shown';
				return undefined;
			}, { windowMs: 10_000, intervalMs: 1_000 });
		});

		await test.step('the refusal changed nothing: Z is still in the local profile', async () => {
			expect(findInDatabaseFile(await localDatabaseFiles(ctx), z), 'the unsynced edit Z is still in the old profile').toBeDefined();
		});

		await test.step('runbook step 4, clear site data: the app starts as a fresh profile', async () => {
			await clearSiteData(ctx);
			ctx.page = await ctx.context.newPage();
			const fresh = new JoplinWebApp(ctx.page);
			await fresh.open(s.web.url);
			await expect(fresh.syncWizard(), 'a fresh profile: the sync wizard shows').toBeVisible();
			s.app = fresh;
		});

		await test.step('runbook step 5, re-sync: sign in, enter the master password, sync', async () => {
			const fresh = s.app;
			await configureJoplinServerSync(fresh, s.web.url, `${s.web.url}/joplin-server`, e2eeAccount);
			await expect(fresh.decryptionBanner(), 'the web app synced and asks for the master password').toBeVisible({ timeout: firstSyncTimeoutMs });
			const screen = await fresh.openEncryptionSettingsFromBanner();
			await screen.enterMasterPassword(e2eeAccount.masterPassword);
			await expect.poll(() => screen.masterPasswordState(), { timeout: 60_000, intervals: [500] }).toBe('accepted');
			await screen.pollDecryptedStats(firstSyncTimeoutMs);
			await expect.poll(async () => {
				const stats = await screen.decryptedStats();
				return stats && stats.total > 0 && stats.done === stats.total ? 'all' : `${stats?.done ?? '-'} / ${stats?.total ?? '-'}`;
			}, { timeout: firstSyncTimeoutMs, intervals: [1_000], message: 'every synced item is decrypted' }).toBe('all');
			await screen.back();
			await syncWebOnce(fresh, ctx.network);
		});

		await test.step('comparison: the UI lists every S0 note of the seed folder, note 1 shows X', async () => {
			const fresh = s.app;
			await fresh.openFolder(s.seedFolder);
			const seedFolderId = s0.folders.find(f => f.title === s.seedFolder)?.id;
			for (const n of s0.notes.filter(n => n.parent_id === seedFolderId && n.deleted_time === 0)) {
				await expect.poll(() => fresh.noteInList(n.title).isVisible(), { timeout: firstSyncTimeoutMs, intervals: [1_000], message: `S0 note ${n.id} is listed after the recovery` }).toBe(true);
			}
			await fresh.openNote(note1.title);
			await new NoteScreen(ctx.page).waitOpen();
			await expect.poll(async () => ((await fresh.frameText()).includes(x) ? 'shown' : 'not shown'), { timeout: 60_000, intervals: [500], message: 'note 1 shows edit X' }).toBe('shown');
			await fresh.backToList();
		});

		await test.step('comparison: one read of the recovered profile holds every S0 item and not Z', async () => {
			const files = await localDatabaseFiles(ctx);
			const missing = [
				...s0.notes.filter(n => !findInDatabaseFile(files, n.title)).map(n => `note ${n.id} (title)`),
				...s0.folders.filter(f => !findInDatabaseFile(files, f.title)).map(f => `folder ${f.id} (title)`),
				...(findInDatabaseFile(files, `${note1.body} ${x}`) ? [] : [`note ${note1.id} (body)`]),
				...(findInDatabaseFile(files, note2.body) ? [] : [`note ${note2.id} (body)`]),
			];
			expect(missing, 'items of S0 missing from the recovered profile\'s database').toEqual([]);
			expect(files.length, 'database files read').toBeGreaterThan(0);
			expect(findInDatabaseFile(files, z), 'the unsynced edit Z is gone from the recovered profile (it was never synced)').toBeUndefined();
		});

		await test.step('data level: after a headless sync, S0 is intact, the account gained only upstream\'s welcome notebook', async () => {
			await syncHeadlessOnce(stack, headlessService);
			expect(restBody(dataApi, note2.id).includes(z), 'REST never had Z').toBe(false);
			const diff = compareSnapshots(s0, restSnapshot(dataApi));
			const addedFolders = new Set(diff.added.filter(a => a.kind === 'folder').map(a => a.id));
			const problems = snapshotProblems(diff, { added: a => a.kind === 'folder' || addedFolders.has(a.parentId) });
			expect(problems, 'S0 is intact, nothing is lost or conflicting, and every added item is a new notebook or a note in one').toEqual([]);
			const now = restSnapshot(dataApi);
			const titles = now.folders.filter(f => addedFolders.has(f.id)).map(f => f.title);
			test.info().annotations.push({ type: 'added-after-recovery', description: `${addedFolders.size} notebooks (${titles.join(', ')}), ${diff.added.filter(a => a.kind === 'note').length} notes` });
		});

		expectNetworkPolicy(s);
	});
});
