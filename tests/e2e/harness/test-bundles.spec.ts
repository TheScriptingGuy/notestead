// Self-checks of the M2-S5 harness (docs/test-plans/M2-S5.md D1 to D8). The product tests (tests/e2e/m2-s5) stand on these:
//   H-BUN-01  the derived bundles: A is the artifact's tree, B, B2 and O differ from A in exactly the files of D2/D3, the manifests
//             describe the trees, and O's migration list has one entry fewer (its NEG: the locator rejects a wrong count)
//   H-RD-01   a sync through a test's own `web`, and a redeploy on the same port keeps the origin, the registration and the profile
//   H-OFF-01  Playwright's offline emulation reaches the service worker (F7): offline, a probe request never reaches the container
//   H-CSD-01  clearSiteData removes the registration, the caches and the OPFS files, and the app starts as a fresh profile after it
// Needs the real upstream bundle: NOTESTEAD_WEB_ARTIFACT=<CI web-bundle artifact dir>.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { configureAndCheckJoplinServerSync, deltaPath, firstSyncTimeoutMs, syncWebOnce, unlockE2ee } from '../support/flows.ts';
import { clearSiteData, opfsPaths } from '../support/localProfile.ts';
import { decodedPathOf } from '../support/network.ts';
import { JoplinWebApp, appStartTimeoutMs } from '../support/pages/joplinWebApp.ts';
import { swCacheKeys, swController, swRegistrations } from '../support/swState.ts';
import { checkTestBundles, dropNewestMigration, treeDigests } from '../support/testBundles.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { freePort } from '../../stack/stack.ts';
import { holdsFor } from '../../support/poll.ts';

test.describe('M2-S5 harness: derived bundles, redeploy, offline and clear site data', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('H-BUN-01 the derived bundles differ from the served one in exactly the planned files, and O has one migration fewer', async ({ stack, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const { versions, nonce } = testBundles;
		expect(checkTestBundles(testBundles), 'the self-check of the derived bundles (D1)').toEqual([]);
		expect(versions.latest, 'the bundle\'s latest database version is the literal\'s last plus one per migration').toBe(versions.base + versions.n);
		test.info().annotations.push({ type: 'versions', description: JSON.stringify(versions) });

		const trees = { a: treeDigests(testBundles.a), b: treeDigests(testBundles.b), b2: treeDigests(testBundles.b2), o: treeDigests(testBundles.o) };
		const differing = (x: ReturnType<typeof treeDigests>, y: ReturnType<typeof treeDigests>): string[] =>
			[...new Set([...x.keys(), ...y.keys()])].filter(p => x.get(p)?.sha256 !== y.get(p)?.sha256).sort();
		expect(differing(trees.a, trees.b), 'B differs from A in the app bundle and the environment file').toEqual(['app.bundle.js', 'environment.js']);
		expect(differing(trees.a, trees.b2), 'B2 also changes the service worker').toEqual(['app.bundle.js', 'environment.js', 'serviceWorker.bundle.js']);
		expect(differing(trees.a, trees.o), 'O differs from A in the app bundle and the environment file').toEqual(['app.bundle.js', 'environment.js']);

		// the manifests are the oracle for "serves bundle X": the changed entries differ from A's and equal the files'
		for (const name of ['b', 'b2', 'o'] as const) {
			const manifest = testBundles.manifests[name];
			expect(manifest.notestead.testBundle, `${name}'s manifest names its bundle`).toBe(name.toUpperCase());
			for (const path of differing(trees.a, trees[name])) {
				const entry = manifest.files.find(f => f.path === path);
				const actual = trees[name].get(path);
				expect(entry, `${name}'s manifest has ${path}`).toBeDefined();
				expect(entry?.sha256, `${name}'s manifest entry for ${path} equals the file`).toBe(actual?.sha256);
				expect(entry?.sha256, `${name}'s manifest entry for ${path} differs from A's`).not.toBe(testBundles.manifests.a.files.find(f => f.path === path)?.sha256);
			}
		}

		// the markers
		const marker = (dir: string, text: string): string => readFileSync(join(dir, 'environment.js'), 'utf8').split('\n').filter(l => l !== '').pop() === `globalThis.notesteadTestBundle = '${text}-${nonce}';` ? text : 'other';
		expect(marker(testBundles.b, 'B')).toBe('B');
		expect(marker(testBundles.b2, 'B2')).toBe('B2');
		expect(marker(testBundles.o, 'O')).toBe('O');
		expect(readFileSync(join(testBundles.a, 'environment.js'), 'utf8')).not.toContain('notesteadTestBundle');

		// O's migration list has n - 1 entries, and the locator refuses a wrong count (its NEG)
		const aJs = readFileSync(join(testBundles.a, 'app.bundle.js'), 'utf8');
		const oJs = readFileSync(join(testBundles.o, 'app.bundle.js'), 'utf8');
		expect(dropNewestMigration(oJs, { base: versions.base, n: versions.n - 1 }).before, 'entries of O\'s migration array').toBe(versions.n - 1);
		expect(() => dropNewestMigration(aJs, { base: versions.base, n: versions.n + 1 }), 'NEG: a wrong expected count is refused').toThrow(new RegExp(`expected ${versions.n + 1} entries, found ${versions.n}`));
	});

	test('H-RD-01 a sync through a test\'s own web works, and a redeploy on the same port keeps the origin and the registration', async ({ stack, e2eeAccount, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const port = await freePort();
		const web = await extraWebs.start({ role: 'web-extra', port, mountDist: testBundles.a });
		expect(web.url).toBe(`http://127.0.0.1:${port}`);
		const ctx = await appContexts.open(web.url, 'rd');
		const app = new JoplinWebApp(ctx.page);
		const first = e2eeAccount.notes?.[0];
		if (!first) throw new Error('the account has no seeded note');

		await test.step('the configuration check succeeds through the test web, then the app syncs and unlocks', async () => {
			const settings = await configureAndCheckJoplinServerSync(app, web.url, `${web.url}/joplin-server`, e2eeAccount);
			expect(await settings.configCheckStatus()).toBe('success');
			await settings.saveAndGoBack();
			await expect(app.decryptionBanner(), 'the web app synced and asks for the master password').toBeVisible({ timeout: firstSyncTimeoutMs });
			await unlockE2ee(app, e2eeAccount);
			await expect.poll(() => app.noteInList(first.title).isVisible(), { timeout: 3 * 60_000, intervals: [1_000] }).toBe(true);
		});

		let scope = '';
		await test.step('one web sync completes through the test web, and the worker controls the page', async () => {
			await syncWebOnce(app, ctx.network);
			const deltas = ctx.network.entries().filter(e => e.method === 'GET' && e.status === 200 && decodedPathOf(e.url) === deltaPath);
			expect(deltas.length, 'a delta request answered 200 through the test web').toBeGreaterThan(0);
			await expect.poll(() => swController(ctx.page), { timeout: 60_000 }).not.toBeNull();
			const registrations = await swRegistrations(ctx.page);
			expect(registrations, 'one registration').toHaveLength(1);
			scope = registrations[0];
		});

		await test.step('redeploy the same bundle on the same port: same origin, same registration, the profile opens', async () => {
			const again = await extraWebs.redeploy(web, { mountDist: testBundles.a });
			expect(again.url, 'the origin does not change').toBe(web.url);
			expect((await extraWebs.accessLog(again)).length, 'the new container has served nothing yet').toBe(0);
			await ctx.page.reload({ timeout: appStartTimeoutMs });
			await expect(app.sidebarButton(), 'the main screen opens on the old profile').toBeVisible({ timeout: appStartTimeoutMs });
			await expect(app.noteInList(first.title)).toBeVisible();
			const registrations = await swRegistrations(ctx.page);
			expect(registrations, 'the same single registration').toEqual([scope]);
			await expect.poll(async () => (await extraWebs.accessLog(again)).some(e => e.method === 'GET' && e.path === '/' && e.status === 200), { timeout: 30_000, message: 'the new container\'s log has the reload\'s GET /' }).toBe(true);
			test.info().annotations.push({ type: 'access-log', description: `${(await extraWebs.accessLog(again)).length} entries after the redeploy's reload` });
		});
	});

	test('H-OFF-01 offline, a request of the page controlled by the worker never reaches the web container', async ({ stack, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const web = await extraWebs.start({ role: 'web-extra', mountDist: testBundles.a });
		const ctx = await appContexts.open(web.url, 'off');
		const app = new JoplinWebApp(ctx.page);
		await app.open(web.url);
		await expect.poll(() => swController(ctx.page), { timeout: 60_000, message: 'the page is controlled by the service worker' }).not.toBeNull();

		// A fresh query string each time: a repeated URL would be answered from the worker's cache even offline.
		const probe = (): Promise<number | string> => {
			const token = `nst${randomBytes(6).toString('hex')}`;
			return ctx.page.evaluate(async t => {
				try {
					return (await fetch(`/source.html?probe=${t}`)).status;
				} catch {
					return 'rejected';
				}
			}, token);
		};
		const sourceHits = async (from: number): Promise<number> => (await extraWebs.accessLog(web)).slice(from).filter(e => e.path === '/source.html').length;

		const online = (await extraWebs.accessLog(web)).length;
		expect(await probe(), 'positive control: online, the probe is answered').toBe(200);
		await expect.poll(() => sourceHits(online), { timeout: 30_000, message: 'positive control: online, the probe reaches the access log' }).toBeGreaterThan(0);

		await ctx.context.setOffline(true);
		const mark = (await extraWebs.accessLog(web)).length;
		expect(await probe(), 'offline, the probe fails').toBe('rejected');
		await holdsFor('no /source.html reaches the container while offline', async () => ((await sourceHits(mark)) > 0 ? 'the probe reached the access log' : undefined), { windowMs: 5_000, intervalMs: 500 });

		await ctx.context.setOffline(false);
		const back = (await extraWebs.accessLog(web)).length;
		expect(await probe(), 'online again, the probe is answered').toBe(200);
		await expect.poll(() => sourceHits(back), { timeout: 30_000, message: 'online again, the probe reaches the access log' }).toBeGreaterThan(0);
	});

	test('H-CSD-01 clear site data removes the registration, the caches and the OPFS files, and the app starts as a fresh profile', async ({ stack, e2eeAccount, extraWebs, appContexts, testBundles }) => {
		await requireUpstreamBundle(stack, 'M2-S5');
		const web = await extraWebs.start({ role: 'web-extra', mountDist: testBundles.a });
		const ctx = await appContexts.open(web.url, 'csd');
		const app = new JoplinWebApp(ctx.page);
		const first = e2eeAccount.notes?.[0];
		if (!first) throw new Error('the account has no seeded note');
		const settings = await configureAndCheckJoplinServerSync(app, web.url, `${web.url}/joplin-server`, e2eeAccount);
		expect(await settings.configCheckStatus()).toBe('success');
		await settings.saveAndGoBack();
		await expect(app.decryptionBanner()).toBeVisible({ timeout: firstSyncTimeoutMs });
		await unlockE2ee(app, e2eeAccount);
		await expect.poll(() => app.noteInList(first.title).isVisible(), { timeout: 3 * 60_000, intervals: [1_000] }).toBe(true);

		await test.step('NEG first: before the clear there is something to clear', async () => {
			await expect.poll(() => swController(ctx.page), { timeout: 60_000 }).not.toBeNull();
			await expect.poll(async () => (await swRegistrations(ctx.page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
			await expect.poll(async () => (await swCacheKeys(ctx.page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
			expect(await opfsPaths(ctx), 'the app\'s database file').toContain('/joplin.sqlite.sqlite3');
		});

		await test.step('after clearSiteData: nothing is left, and a new page shows the sync wizard', async () => {
			await clearSiteData(ctx);
			ctx.page = await ctx.context.newPage();
			const fresh = new JoplinWebApp(ctx.page);
			await fresh.open(web.url);
			await expect(fresh.syncWizard(), 'a fresh profile starts with the sync wizard').toBeVisible();
		});
	});
});
