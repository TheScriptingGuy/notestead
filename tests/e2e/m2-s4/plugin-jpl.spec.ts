// M2-S4 / M2-AC9 (docs/backlog/M2.md §M2-S4; docs/test-plans/M2-S4.md): the user's repeating-todos plugin (2.1.2, pinned in
// tests/fixtures/plugins/repeating-todos) is uploaded as a .jpl with plugin support enabled in Configuration, installs enabled,
// survives a reload, adds no views.menus entry on web (NEG1, L2), and its core behaviour works: completing a daily to-do reopens
// the same to-do with its due date one day later, in the UI and through the headless REST Data API. M2-AC9-02 is the negative
// control: the same flow without the plugin. The recurrence is seeded through REST (plan P6, D2). The account is an unlocked
// E2EE account (L18). Needs the real upstream bundle: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled, ok, pick, restGet } from '../support/dataApi.ts';
import { localNoonEpoch, partsIn, userTimeZone } from '../support/dueDate.ts';
import { expect, test } from '../support/fixtures.ts';
import type { DataApi } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebThenHeadless } from '../support/flows.ts';
import { endOfTestViolations } from '../support/network.ts';
import type { NetworkRecorder } from '../support/network.ts';
import { localFilesNamed } from '../support/localProfile.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import type { PluginsScreen } from '../support/pages/joplinWebApp.ts';
import { attachPluginConsole, enablePluginSupport, installPluginFromFile, pluginRepositoryPrefixes, pluginRepoActivity, pluginRunning } from '../support/plugins.ts';
import { pluginMenuLabels, pluginNoteToolbarLabel, recurrenceOf, recurringTagTitle, repeatingTodoUserData, repeatingTodosFixture } from '../support/repeatingTodos.ts';
import { allItems, noteTagTitles, tagsTitled } from '../support/restQueries.ts';
import { longSpecTimeoutMs, navigationTimeoutMs } from '../support/timeouts.ts';
import { holdsFor } from '../../support/poll.ts';
import { syncHeadlessOnce } from '../../stack/stack.ts';

const fx = repeatingTodosFixture();
const todoFields = 'id,is_todo,todo_due,todo_completed,is_conflict';
const seededRecurrence = JSON.parse(repeatingTodoUserData({ interval: 'day' }, 0)) as Record<string, { recurrence: { v: unknown } }>;
const seededV = seededRecurrence[fx.id].recurrence.v;

interface Seed { R: string; T: string; rId: string; tId: string; due: number; expectedDue: number; folderId: string; folderIdsBefore: string[] }

// Step 0 of both tests: two to-dos due tomorrow 12:00 Europe/Amsterdam (plan D10), R with a daily recurrence in its user_data and
// the tag "recurring", T the twin without either; the seed is read back before anything else happens.
const seedTodos = (dataApi: DataApi, note1Id: string, run: string): Seed => {
	const R = `Notestead repeating ${run}`;
	const T = `Notestead once ${run}`;
	const now = Date.now();
	const due = localNoonEpoch(now, 1, userTimeZone);
	const expectedDue = localNoonEpoch(now, 2, userTimeZone);
	const get = restGet(dataApi);
	const folderId = String(ok(dataApi.get(`/notes/${note1Id}?fields=parent_id`), 'GET the seeded note').parent_id);
	expect(tagsTitled(get, recurringTagTitle), 'no tag titled "recurring" exists yet').toEqual([]);
	const create = (title: string): string => String(ok(dataApi.request('POST', '/notes', { title, is_todo: 1, todo_due: due, parent_id: folderId }), `POST /notes ${title}`).id);
	const rId = create(R);
	const tId = create(T);
	ok(dataApi.request('PUT', `/notes/${rId}`, { user_data: repeatingTodoUserData({ interval: 'day' }, Date.now()) }), 'PUT user_data');
	const tagId = String(ok(dataApi.request('POST', '/tags', { title: recurringTagTitle }), 'POST /tags').id);
	ok(dataApi.request('POST', `/tags/${tagId}/notes`, { id: rId }), 'POST /tags/:id/notes');

	expect(recurrenceOf(String(ok(dataApi.get(`/notes/${rId}?fields=user_data`), 'GET R user_data').user_data)), 'the seeded recurrence reads back through REST').toEqual(seededV);
	expect(noteTagTitles(get, rId), 'R carries the tag').toEqual([recurringTagTitle]);
	expect(noteTagTitles(get, tId), 'T carries no tag').toEqual([]);
	expect(ok(dataApi.get(`/notes/${tId}?fields=user_data`), 'GET T user_data').user_data, 'T has no user_data').toBe('');
	const folderIdsBefore = allItems(get, `/folders/${folderId}/notes`, 'id').map(n => String(n.id)).sort();
	return { R, T, rId, tId, due, expectedDue, folderId, folderIdsBefore };
};

const expectNetworkClean = (webNetwork: NetworkRecorder, origin: string, serverUrl: string): void => {
	expect(endOfTestViolations(webNetwork.entries(), origin, webNetwork.allowed()), 'cross-origin requests outside the plugin repository').toEqual([]);
	expect(webNetwork.entries().filter(e => e.url.startsWith(serverUrl)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
	test.info().annotations.push({ type: 'plugin-repo', description: pluginRepoActivity(webNetwork.entries()).join('; ') || 'none' });
};

// The card shows no Incompatible, Error or Disabled chip, and the info dialog's "Enabled" switch is on.
const expectInstalledAndEnabled = async (plugins: PluginsScreen, count: number): Promise<void> => {
	await expect(plugins.installedHeading(count)).toBeVisible();
	await expect(plugins.card(fx.name)).toBeVisible();
	const chips = await plugins.chips(fx.name);
	for (const bad of ['Incompatible', 'Error', 'Disabled']) expect(chips, `the "${fx.name}" card shows no "${bad}" chip`).not.toContain(bad);
	await plugins.openInfo(fx.name);
	await expect(plugins.enabledSwitch(), 'the Enabled switch is on').toHaveAttribute('aria-checked', 'true');
	await plugins.closeInfo();
};

test.describe('M2-S4 plugins from a .jpl file', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test.afterEach(async ({ webApp }, testInfo) => {
		await attachPluginConsole(webApp, testInfo);
	});

	test('M2-AC9-01 the repeating-todos .jpl uploaded with plugin support enabled installs enabled, survives a reload, has no views.menus entry on web (NEG1), and reopens a completed daily to-do with its due date one day later, in the UI and through REST', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S4');
		for (const prefix of pluginRepositoryPrefixes) webNetwork.allow(prefix);
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const run = randomBytes(4).toString('hex');
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');
		const get = restGet(dataApi);
		const cycle = async (label: string): Promise<void> => {
			const { webMs, headlessMs, healthAtReady } = await syncWebThenHeadless(app, webNetwork, stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `${label}: web ${webMs} ms, headless ${headlessMs} ms` });
			if (healthAtReady !== 'healthy') test.info().annotations.push({ type: 'health-lag', description: `${label}: podman health ${healthAtReady} while /healthz was ready` });
		};
		const readTodo = (id: string): Record<string, unknown> => pick(ok(dataApi.get(`/notes/${id}?fields=${todoFields}`), `GET /notes/${id}`), todoFields.split(','));
		const userDataOf = (id: string): string => String(ok(dataApi.get(`/notes/${id}?fields=user_data`), `GET /notes/${id} user_data`).user_data);

		let seed: Seed = { R: '', T: '', rId: '', tId: '', due: 0, expectedDue: 0, folderId: '', folderIdsBefore: [] };
		let plugins: PluginsScreen;
		let doneAt = 0;

		await test.step('0. the seed: R (daily, tagged) and T (twin), due tomorrow 12:00 Europe/Amsterdam', async () => {
			seed = seedTodos(dataApi, note1.id, run);
			await syncHeadlessOnce(stack, headlessService);
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			await app.openFolder(seedFolder);
			await expect.poll(async () => `${await app.todoCheckbox(seed.R).getAttribute('aria-checked')} ${await app.todoCheckbox(seed.T).getAttribute('aria-checked')}`, { message: 'R and T are in the list, not done', timeout: 3 * 60_000, intervals: [1_000] }).toBe('false false');
		});

		await test.step('1. Configuration, Plugins, "Enable plugin support": no plugins are installed', async () => {
			plugins = await enablePluginSupport(app);
			await expect(plugins.noneInstalled()).toBeVisible();
		});

		await test.step('2. Install from file: installed, enabled, no incompatible, error or disabled chip', async () => {
			await installPluginFromFile(plugins, fx.path);
			await expectInstalledAndEnabled(plugins, 1);
		});

		await test.step('3. running: "Open Recurrence Dialog" is in R\'s action menu', async () => {
			await app.backToList();
			await app.openNote(seed.R);
			await note.waitOpen();
			await pluginRunning(note, 120_000);
			await app.backToList();
		});

		await test.step('4. reload: the plugin is still installed, enabled and running', async () => {
			await webApp.page.reload();
			await app.sidebarButton().waitFor({ timeout: navigationTimeoutMs });
			plugins = await (await app.openConfiguration()).openSection('Plugins');
			await expectInstalledAndEnabled(plugins, 1);
			await app.backToList();
			await app.openNote(seed.R);
			await note.waitOpen();
			await pluginRunning(note, 120_000);
		});

		await test.step('NEG1. views.menus is absent on web (L2); the positive control is the note toolbar item', async () => {
			const names = await note.menuItemNames();
			expect(names, 'positive control: the plugin\'s note toolbar command is in the note action menu').toContain(pluginNoteToolbarLabel);
			for (const label of pluginMenuLabels) expect(names, `"${label}" found in the note action menu`).not.toContain(label);
			await note.actionsButton().click();
			const menuHtml = await app.frameHtml();
			for (const label of pluginMenuLabels) expect(menuHtml.includes(label), `"${label}" found in the menu html (action menu open)`).toBe(false);
			await webApp.page.keyboard.press('Escape');
			await app.backToList();
			await app.openSidebar();
			const sideHtml = await app.frameHtml();
			for (const label of pluginMenuLabels) expect(sideHtml.includes(label), `"${label}" found in the side menu html`).toBe(false);
			await app.closeSidebar();
		});

		await test.step('5. tick R and T in the note list', async () => {
			doneAt = Date.now();
			await app.todoCheckbox(seed.R).click();
			await app.todoCheckbox(seed.T).click();
			await expect(app.todoCheckbox(seed.R)).toHaveAttribute('aria-checked', 'true');
			await expect(app.todoCheckbox(seed.T)).toHaveAttribute('aria-checked', 'true');
		});

		await test.step('6. R is unchecked again by the plugin; T stays checked', async () => {
			await expect.poll(() => app.todoCheckbox(seed.R).getAttribute('aria-checked'), { message: 'R is unchecked again by the plugin', timeout: 120_000, intervals: [1_000] }).toBe('false');
			await expect(app.todoCheckbox(seed.T)).toHaveAttribute('aria-checked', 'true');
			test.info().annotations.push({ type: 'reopen', description: `R unchecked after ${Date.now() - doneAt} ms` });
		});

		await test.step('7. cycle: R is the same to-do, due one day later; T is completed with its due date unchanged', async () => {
			await cycle('reopen');
			await expect.poll(() => readTodo(seed.rId), { message: 'R reopened with the due date one local day later', timeout: 60_000, intervals: [1_000] })
				.toEqual({ id: seed.rId, is_todo: 1, todo_due: seed.expectedDue, todo_completed: 0, is_conflict: 0 });
			expect(recurrenceOf(userDataOf(seed.rId)), 'R\'s recurrence is still daily and enabled').toMatchObject({ enabled: true, interval: 'day', intervalNumber: 1 });
			expect(notesTitled(dataApi, seed.R, { includeDeleted: true }).map(n => n.id), 'no new occurrence: exactly one note has R\'s title').toEqual([seed.rId]);
			expect(allItems(get, `/folders/${seed.folderId}/notes`, 'id').map(n => String(n.id)).sort(), 'the notebook holds the same notes').toEqual(seed.folderIdsBefore);
			const t = readTodo(seed.tId);
			expect(t.todo_due, 'T\'s due date is unchanged').toBe(seed.due);
			expect(Number(t.todo_completed), 'T is completed at the time of the click').toBeGreaterThanOrEqual(doneAt - 60_000);
			expect(Number(t.todo_completed), 'T is completed at the time of the click').toBeLessThanOrEqual(Date.now() + 60_000);
			const expected = partsIn(seed.expectedDue, userTimeZone);
			expect(expected.hour, 'oracle guard: noon').toBe('12');
			expect(expected.day, 'oracle guard: not the same day as the seeded due date').not.toBe(partsIn(seed.due, userTimeZone).day);
		});

		await test.step('8. OPFS: exactly one stored .jpl, with the fixture\'s size and sha256', async () => {
			const files = await localFilesNamed(webApp, `${fx.id}.jpl`);
			expect(files, 'one stored copy of the plugin').toHaveLength(1);
			expect(files[0].path).toMatch(new RegExp(`/plugins/${fx.id.replace(/\./g, '\\.')}\\.jpl$`));
			expect({ size: files[0].size, sha256: files[0].sha256 }).toEqual({ size: fx.size, sha256: fx.sha256 });
			test.info().annotations.push({ type: 'opfs', description: files[0].path });
		});

		await test.step('9. network policy', async () => {
			expectNetworkClean(webNetwork, origin, joplinServer.url);
		});
	});

	test('M2-AC9-02 negative control: without the plugin, a completed repeating to-do stays completed with its due date unchanged', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S4');
		for (const prefix of pluginRepositoryPrefixes) webNetwork.allow(prefix);
		const app = new JoplinWebApp(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const run = randomBytes(4).toString('hex');
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');
		const readTodo = (id: string): Record<string, unknown> => pick(ok(dataApi.get(`/notes/${id}?fields=id,todo_completed,todo_due`), `GET /notes/${id}`), ['id', 'todo_completed', 'todo_due']);
		let seed: Seed = { R: '', T: '', rId: '', tId: '', due: 0, expectedDue: 0, folderId: '', folderIdsBefore: [] };

		await test.step('0. the seed, as in M2-AC9-01', async () => {
			seed = seedTodos(dataApi, note1.id, run);
			await syncHeadlessOnce(stack, headlessService);
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			await app.openFolder(seedFolder);
			await expect.poll(async () => `${await app.todoCheckbox(seed.R).getAttribute('aria-checked')} ${await app.todoCheckbox(seed.T).getAttribute('aria-checked')}`, { message: 'R and T are in the list, not done', timeout: 3 * 60_000, intervals: [1_000] }).toBe('false false');
		});

		await test.step('1. plugin support enabled, and no plugin is installed', async () => {
			const plugins = await enablePluginSupport(app);
			await expect(plugins.noneInstalled()).toBeVisible();
			await app.backToList();
		});

		await test.step('2. tick R: it stays completed for 75 s (2.5 sweep periods)', async () => {
			await app.todoCheckbox(seed.R).click();
			await expect(app.todoCheckbox(seed.R)).toHaveAttribute('aria-checked', 'true');
			await holdsFor('R stays completed without the plugin', async () => {
				const state = await app.todoCheckbox(seed.R).getAttribute('aria-checked');
				return state === 'true' ? undefined : `aria-checked is ${String(state)}`;
			}, { windowMs: 75_000, intervalMs: 1_000 });
		});

		await test.step('3. cycle: REST shows R completed, its due date and recurrence unchanged', async () => {
			const { webMs, headlessMs } = await syncWebThenHeadless(app, webNetwork, stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `negative control: web ${webMs} ms, headless ${headlessMs} ms` });
			await expect.poll(() => Number(readTodo(seed.rId).todo_completed) > 0, { message: 'R is completed in the headless service', timeout: 60_000, intervals: [1_000] }).toBe(true);
			expect(readTodo(seed.rId).todo_due, 'R\'s due date is unchanged').toBe(seed.due);
			expect(recurrenceOf(String(ok(dataApi.get(`/notes/${seed.rId}?fields=user_data`), 'GET R user_data').user_data)), 'R\'s recurrence is unchanged').toEqual(seededV);
		});

		await test.step('4. OPFS: the plugin was never installed', async () => {
			expect(await localFilesNamed(webApp, `${fx.id}.jpl`)).toEqual([]);
		});

		await test.step('5. network policy', async () => {
			expectNetworkClean(webNetwork, origin, joplinServer.url);
		});
	});
});
