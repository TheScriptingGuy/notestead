// M2-S2 / M2-AC5 (docs/backlog/M2.md §M2-S2; docs/test-plans/M2-S2.md): a to-do with a due date is created in the web UI; the
// headless REST API has is_todo 1 and todo_due as the epoch of the wall-clock time typed under Europe/Amsterdam (plan D5);
// marking it done sets todo_completed. NEG (limitation L1, D6): the web app shows no notification at the due time. A spy on the
// Notification APIs counts in every frame from load until 30 s after the due time, in real time; its positive control is a
// Notification the test constructs itself, and upstream's own warning ("showing notifications is not supported by Joplin Web")
// is asserted too. The account is an unlocked E2EE account (D1, L18).
// Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled, ok, pick } from '../support/dataApi.ts';
import { userTimeZone, nextWholeMinute, partsIn } from '../support/dueDate.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebThenHeadless } from '../support/flows.ts';
import { classifyRequests, violationLines } from '../support/network.ts';
import { installNotificationSpy, readNotificationSpy } from '../support/notificationSpy.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { holdsFor } from '../../support/poll.ts';

const todoFields = 'id,is_todo,todo_due,todo_completed,parent_id';
const l1Warning = 'Warning: The due-date has been saved, but showing notifications is not supported by Joplin Web.';

test.describe('M2-S2 to-dos in the web app', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC5 a to-do created in the web UI with a due date has is_todo and the due epoch under Europe/Amsterdam in the REST API, marking it done sets todo_completed, and (NEG, L1) no notification is shown at the due time', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S2');
		await installNotificationSpy(webApp.context);
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const run = randomBytes(4).toString('hex');
		const TD = `Notestead web todo ${run}`;
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');

		const readTodo = (id: string): Record<string, unknown> => pick(ok(dataApi.get(`/notes/${id}?fields=${todoFields}`), `GET /notes/${id}`), todoFields.split(','));
		const cycle = async (label: string): Promise<void> => {
			const { webMs, headlessMs } = await syncWebThenHeadless(app, webNetwork, stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `${label}: web ${webMs} ms, headless ${headlessMs} ms` });
		};

		let seedFolderId = '';
		let docId = '';
		let due = 0;
		let id = '';
		let doneAt = 0;

		await test.step('0. the page runs in Europe/Amsterdam', async () => {
			seedFolderId = String(ok(dataApi.get(`/notes/${note1.id}?fields=parent_id`), 'GET the seeded note').parent_id);
			expect(pick(ok(dataApi.get(`/folders/${seedFolderId}?fields=title`), 'GET the seeded folder'), ['title'])).toEqual({ title: seedFolder });
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			expect(await webApp.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'the page\'s time zone').toBe(userTimeZone);
			const first = await readNotificationSpy(webApp.page);
			expect(first.main, 'the spy is installed in the main frame and has counted nothing').toMatchObject({ installed: true, constructed: 0, requested: 0, shown: 0 });
			docId = first.main?.docId ?? '';
		});

		await test.step('1. create the to-do in the seeded notebook, typed like a user', async () => {
			await app.openFolder(seedFolder);
			await app.newTodo();
			await note.typeTitle(TD);
			await app.backToList();
			await expect(app.todoCheckbox(TD)).toHaveAttribute('aria-checked', 'false');
		});

		await test.step('2. set the due date and save it: upstream\'s web warning', async () => {
			await app.openNote(TD);
			await note.waitOpen();
			const alarm = await note.openAlarm();
			due = nextWholeMinute(Date.now(), 150_000);
			await alarm.enterLocal(partsIn(due, userTimeZone));
			expect(due - Date.now(), 'at least a minute before the due time when it is saved').toBeGreaterThan(60_000);
			expect(await alarm.save()).toBe(l1Warning);
			await app.backToList();
		});

		await test.step('3. cycle: is_todo and the due epoch', async () => {
			await cycle('create');
			await expect.poll(() => notesTitled(dataApi, TD).map(n => n.id), { timeout: 60_000, intervals: [1_000] }).toHaveLength(1);
			id = String(notesTitled(dataApi, TD)[0].id);
			await expect.poll(() => readTodo(id), { timeout: 60_000, intervals: [1_000] })
				.toEqual({ id, is_todo: 1, todo_due: due, todo_completed: 0, parent_id: seedFolderId });
		});

		await test.step('4. NEG (L1): no notification from load until 30 s after the due time', async () => {
			const end = due + 30_000;
			await holdsFor('no Notification at or after the due time', async () => {
				const reading = await readNotificationSpy(webApp.page);
				if (!reading.main) return 'the spy is not installed in the main frame';
				if (reading.main.docId !== docId) return 'the page was reloaded, so the spy restarted';
				if (reading.constructed + reading.requested + reading.shown > 0) return `notification API used: constructed ${reading.constructed}, requested ${reading.requested}, shown ${reading.shown}`;
				return undefined;
			}, { windowMs: Math.max(0, end - Date.now()), intervalMs: 1_000 });
			expect(Date.now(), 'the window ended after the due time').toBeGreaterThanOrEqual(end);
			// Positive control: the spy sees a Notification that the test constructs itself.
			await webApp.page.evaluate(() => {
				const N = (globalThis as unknown as { Notification: new (title: string) => unknown }).Notification;
				void new N('nst-spy-control');
			});
			expect((await readNotificationSpy(webApp.page)).main?.constructed, 'the spy counts the control').toBe(1);
		});

		await test.step('5. mark it done in the note list', async () => {
			doneAt = Date.now();
			await app.todoCheckbox(TD).click();
			await expect(app.todoCheckbox(TD)).toHaveAttribute('aria-checked', 'true');
		});

		await test.step('6. cycle: todo_completed is set', async () => {
			await cycle('done');
			await expect.poll(() => {
				const completed = Number(readTodo(id).todo_completed);
				return completed > 0 ? 'completed' : `todo_completed ${completed}`;
			}, { timeout: 60_000, intervals: [1_000] }).toBe('completed');
			const done = readTodo(id);
			expect(done).toMatchObject({ id, is_todo: 1, todo_due: due });
			expect(Number(done.todo_completed), 'todo_completed is the time of the click').toBeGreaterThanOrEqual(doneAt - 60_000);
			expect(Number(done.todo_completed), 'todo_completed is the time of the click').toBeLessThanOrEqual(Date.now() + 60_000);
		});

		await test.step('7. network policy', async () => {
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
		});
	});
});
