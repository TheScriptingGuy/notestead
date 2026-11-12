// L20 characterisation (docs/test-plans/M2-S3.md D-W1, WEB-SQLITE-1; docs/worklog/WEB-SQLITE-1.md §2, §4): the web app's one SQLite
// connection lets a user's single `UPDATE notes` run inside a settings batch's open transaction, so when that batch fails and
// ROLLBACK follows, the edit is undone although the screen shows it. WSQ-01 asserts today's documented behaviour (the edit is lost),
// WSQ-02 and WSQ-03 are the controls. When upstream fixes it, WSQ-01(c) fails with the flip text (the M2-AC20/L14 pattern: green
// while the documented limitation holds, red the moment it changes, never skipped). No headless service and no sync: the real
// served bundle on a real profile (the unlock is needed for one). Needs NOTESTEAD_WEB_ARTIFACT=<CI artifact dir>.
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import type { WebApp } from '../support/fixtures.ts';
import { openUnlockedWebApp } from '../support/flows.ts';
import { expectNotStoredLocally, expectStoredLocally } from '../support/localProfile.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { armFault, fullTitleSeen, installSettingsFault, readFault, releaseFault, releaseReady } from '../support/sqliteFault.ts';
import type { FaultEvent } from '../support/sqliteFault.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';

const allowReason = 'WSQ: a failing settings statement is injected on purpose (L20 characterisation)';

const eventsOf = async (webApp: WebApp, kind: FaultEvent['kind']): Promise<FaultEvent[]> => (await readFault(webApp.page)).filter(e => e.kind === kind);

test.describe('L20 web SQLite transaction scope', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	// Arms the fault, then provokes a settings batch through the UI (selecting another notebook changes a persisted setting and
	// upstream saves settings 500 ms later), and waits for the batch's DELETE to be held. If the UI step provokes none, the app's
	// own periodic settings save is waited for, up to 3 min (WO-29 step 3).
	const holdASettingsBatch = async (webApp: WebApp, app: JoplinWebApp, otherFolder: string): Promise<void> => {
		await armFault(webApp.page);
		await app.openFolder(otherFolder);
		await expect.poll(async () => (await eventsOf(webApp, 'held')).length, { message: 'a settings batch is held', timeout: 3 * 60_000, intervals: [500] }).toBe(1);
	};

	test('WSQ-01 documents L20: a title edit made while a failing settings batch is open is rolled back with it', async ({ stack, joplinServer, e2eeAccount, webApp }) => {
		await requireUpstreamBundle(stack, 'M2-S3');
		webApp.allowSqliteFailures(allowReason);
		await installSettingsFault(webApp.context);
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const note1 = e2eeAccount.notes?.[0];
		const seedFolder = e2eeAccount.folder;
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');
		const newTitle = `Notestead wsq lost ${randomBytes(4).toString('hex')}`;

		await test.step('1. open the web app and unlock it; the worker messages are visible to the fault script', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			await expect.poll(async () => (await readFault(webApp.page)).length, { message: 'the fault script saw the app\'s SQLite worker messages (a BEGIN)', timeout: 60_000, intervals: [500] }).toBeGreaterThan(0);
		});

		await test.step('2. hold a settings batch open', async () => {
			await app.openFolder(seedFolder);
			await holdASettingsBatch(webApp, app, 'Trash');
		});

		await test.step('3. edit the title while the batch is held, then release it', async () => {
			await app.openFolder(seedFolder);
			await app.openNote(note1.title);
			await note.waitOpen();
			await note.typeTitle(newTitle, { replace: true });
			// WO-29a: release only when the FULL title's UPDATE is inside the held transaction and the save queue (upstream's 500 ms
			// AsyncActionQueue) has been quiet for 1.5 s; an earlier, partial-title save is not enough.
			await expect.poll(async () => releaseReady(await fullTitleSeen(webApp.page, newTitle), await webApp.page.evaluate(() => (globalThis as unknown as { performance: { now: () => number } }).performance.now())), { message: 'the full title\'s UPDATE is inside the held batch and the save queue is quiet', timeout: 60_000, intervals: [100] }).toBe('release');
			await releaseFault(webApp.page);
		});

		await test.step('4. (a) the batch failed and was rolled back; (b) the screen shows the new title; (c) the database does not hold it', async () => {
			await expect.poll(() => webApp.console.some(l => l.includes('Could not save settings')), { message: 'the console has "Could not save settings"', timeout: 10_000, intervals: [250] }).toBe(true);
			const held = (await eventsOf(webApp, 'held'))[0].t;
			await expect.poll(async () => (await eventsOf(webApp, 'rollback')).some(e => e.t > held), { message: 'a ROLLBACK after the held BEGIN', timeout: 10_000, intervals: [250] }).toBe(true);
			// the guard (WO-29a): a title sent again after the release lands outside the rolled-back batch, so the run tests nothing
			const releasedAt = (await eventsOf(webApp, 'released'))[0].t;
			expect((await eventsOf(webApp, 'update-seen')).filter(e => e.t > releasedAt).length, 'WSQ-01 invalid run: the title was sent again after the release; this run does not test L20').toBe(0);
			await app.backToList();
			await expect(app.noteInList(newTitle), 'the list shows the new title').toBeVisible();
			await expectNotStoredLocally(webApp, newTitle, 'the edited title', { holdMs: 15_000 });
		});
	});

	test('WSQ-02 control: the same failing batch, with the edit made after it rolled back, keeps the edit', async ({ stack, joplinServer, e2eeAccount, webApp }) => {
		await requireUpstreamBundle(stack, 'M2-S3');
		webApp.allowSqliteFailures(allowReason);
		await installSettingsFault(webApp.context);
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const note1 = e2eeAccount.notes?.[0];
		const seedFolder = e2eeAccount.folder;
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');
		const newTitle = `Notestead wsq kept ${randomBytes(4).toString('hex')}`;

		await test.step('1. open the web app and unlock it', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			await app.openFolder(seedFolder);
		});

		await test.step('2. hold a settings batch, release it, and wait for its rollback', async () => {
			await holdASettingsBatch(webApp, app, 'Trash');
			await releaseFault(webApp.page);
			const held = (await eventsOf(webApp, 'held'))[0].t;
			await expect.poll(async () => (await eventsOf(webApp, 'rollback')).some(e => e.t > held), { message: 'a ROLLBACK after the held BEGIN', timeout: 10_000, intervals: [250] }).toBe(true);
			await expect.poll(() => webApp.console.some(l => l.includes('Could not save settings')), { message: 'the console has "Could not save settings"', timeout: 10_000, intervals: [250] }).toBe(true);
		});

		await test.step('3. the edit made after the rollback is stored', async () => {
			await app.openFolder(seedFolder);
			await app.openNote(note1.title);
			await note.waitOpen();
			await note.typeTitle(newTitle, { replace: true });
			await app.backToList();
			await expect(app.noteInList(newTitle)).toBeVisible();
			await expectStoredLocally(webApp, newTitle, 'the edited title');
		});
	});

	test('WSQ-03 control: no fault, the edit is stored, and the SQLite failure rule stays in force', async ({ stack, joplinServer, e2eeAccount, webApp }) => {
		await requireUpstreamBundle(stack, 'M2-S3');
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const note1 = e2eeAccount.notes?.[0];
		const seedFolder = e2eeAccount.folder;
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');
		const newTitle = `Notestead wsq plain ${randomBytes(4).toString('hex')}`;

		await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
		await app.openFolder(seedFolder);
		await app.openNote(note1.title);
		await note.waitOpen();
		await note.typeTitle(newTitle, { replace: true });
		await app.backToList();
		await expect(app.noteInList(newTitle)).toBeVisible();
		await expectStoredLocally(webApp, newTitle, 'the edited title');
	});
});
