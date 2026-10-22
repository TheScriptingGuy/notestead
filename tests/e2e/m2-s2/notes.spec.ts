// M2-S2 / M2-AC3 (docs/backlog/M2.md §M2-S2; docs/test-plans/M2-S2.md): a note is created, edited (title and body typed like a
// user), moved to another notebook and deleted to the trash in the web UI, and after one web sync and one headless sync per
// operation the headless REST Data API holds exactly what was typed or chosen: the same id throughout (an edit is an update),
// the old value gone, no conflict copy (plan D4). The account is an unlocked E2EE account (D1, L18), so the first cycle also
// proves that the web app's own upload is encrypted on the server. One web sync is syncWebOnce, one headless sync is the
// restart of the test's own headless service (D2, D3).
// Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled, ok, pick, restGet } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebThenHeadless } from '../support/flows.ts';
import { classifyRequests, violationLines } from '../support/network.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { foldersTitled } from '../support/restQueries.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { serverItemContent } from '../../stack/stack.ts';

const noteFields = 'id,title,body,parent_id,is_todo,deleted_time,is_conflict,encryption_applied';

test.describe('M2-S2 notes in the web app', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC3 a note created, edited (typed like a user), moved and deleted to the trash in the web UI is reflected exactly in the headless REST API after one web sync and one headless sync each', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S2');
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const get = restGet(dataApi);
		const run = randomBytes(4).toString('hex');
		const T1 = `Notestead web note ${run}`;
		const B1 = `Body typed in the web app ${run}`;
		const T2 = `Notestead edited note ${run} Δ`;
		const B2 = `Edited body ${run}\nSecond line ✓ ünïcödé`;
		const target = `Notestead target ${run}`;
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');

		const readNote = (id: string): Record<string, unknown> => pick(ok(dataApi.get(`/notes/${id}?fields=${noteFields}`), `GET /notes/${id}`), noteFields.split(','));
		// One web sync, then one headless sync (a restart of the test's own service); the durations feed watch item W1.
		const cycle = async (label: string): Promise<void> => {
			const { webMs, headlessMs } = await syncWebThenHeadless(app, webNetwork, stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `${label}: web ${webMs} ms, headless ${headlessMs} ms` });
		};

		let seedFolderId = '';
		let id = '';
		let targetId = '';
		let deletedAt = 0;

		await test.step('0. data level before: the seeded note\'s folder', async () => {
			seedFolderId = String(ok(dataApi.get(`/notes/${note1.id}?fields=parent_id`), 'GET the seeded note').parent_id);
			expect(seedFolderId).not.toBe('');
			expect(pick(ok(dataApi.get(`/folders/${seedFolderId}?fields=title`), 'GET the seeded folder'), ['title'])).toEqual({ title: seedFolder });
		});

		await test.step('1. open the web app and unlock it', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
		});

		await test.step('2. create the target notebook in the UI', async () => {
			await app.createNotebook(target);
		});

		await test.step('3. create the note in the seeded notebook, typed like a user', async () => {
			await app.openFolder(seedFolder);
			await app.newNote();
			await note.typeTitle(T1);
			await note.typeBody(B1);
			await app.backToList();
			await expect(app.noteInList(T1)).toBeVisible();
		});

		await test.step('4. one web sync and one headless sync: the note as created', async () => {
			await cycle('create');
			await expect.poll(() => notesTitled(dataApi, T1).map(n => n.id), { timeout: 60_000, intervals: [1_000] }).toHaveLength(1);
			id = String(notesTitled(dataApi, T1)[0].id);
			await expect.poll(() => readNote(id), { timeout: 60_000, intervals: [1_000] })
				.toEqual({ id, title: T1, body: B1, parent_id: seedFolderId, is_todo: 0, deleted_time: 0, is_conflict: 0, encryption_applied: 0 });
			const onServer = await serverItemContent(stack, e2eeAccount, `${id}.md`);
			expect(onServer.status, 'GET the note from the server').toBe(200);
			expect(onServer.text, 'the web app uploaded the note encrypted').toMatch(/^encryption_applied: 1$/m);
			expect(onServer.text.includes(run), 'no run text in clear on the server').toBe(false);
			const targets = foldersTitled(get, target);
			expect(targets, 'exactly one target notebook').toHaveLength(1);
			expect(targets[0].parent_id, 'the target notebook is top-level').toBe('');
			targetId = String(targets[0].id);
		});

		await test.step('5. edit the title and the body, typed like a user', async () => {
			await app.openNote(T1);
			await note.waitOpen();
			await note.typeTitle(T2, { replace: true });
			await note.typeBody(B2, { replace: true });
			await app.backToList();
			await expect(app.noteInList(T2)).toBeVisible();
			await expect(app.noteInList(T1)).toHaveCount(0);
		});

		await test.step('6. cycle: the same note, edited', async () => {
			await cycle('edit');
			await expect.poll(() => readNote(id), { timeout: 60_000, intervals: [1_000] })
				.toEqual({ id, title: T2, body: B2, parent_id: seedFolderId, is_todo: 0, deleted_time: 0, is_conflict: 0, encryption_applied: 0 });
			expect(notesTitled(dataApi, T1), 'the old title is gone').toEqual([]);
			expect(notesTitled(dataApi, T2).map(n => n.id), 'an update, not a copy').toEqual([id]);
		});

		await test.step('7. move it to the target notebook', async () => {
			await app.openNote(T2);
			await note.waitOpen();
			await note.moveTo(seedFolder, target);
			await app.backToList();
			await app.openFolder(target);
			await expect(app.noteInList(T2)).toBeVisible();
		});

		await test.step('8. cycle: the note in the target notebook, nothing else changed', async () => {
			await cycle('move');
			await expect.poll(() => readNote(id), { timeout: 60_000, intervals: [1_000] })
				.toEqual({ id, title: T2, body: B2, parent_id: targetId, is_todo: 0, deleted_time: 0, is_conflict: 0, encryption_applied: 0 });
			expect(notesTitled(dataApi, T2).map(n => n.id)).toEqual([id]);
		});

		await test.step('9. delete it to the trash', async () => {
			await app.openNote(T2);
			await note.waitOpen();
			deletedAt = Date.now();
			await note.deleteToTrash();
			await app.backToList();
			await expect.poll(() => app.noteInList(T2).count(), { timeout: 30_000, intervals: [500] }).toBe(0);
		});

		await test.step('10. cycle: the note in the trash', async () => {
			await cycle('delete');
			await expect.poll(() => {
				const deleted = Number(readNote(id).deleted_time);
				return deleted > 0 ? 'trashed' : `deleted_time ${deleted}`;
			}, { timeout: 60_000, intervals: [1_000] }).toBe('trashed');
			const trashed = readNote(id);
			expect(trashed).toMatchObject({ title: T2, body: B2, parent_id: targetId, is_conflict: 0 });
			expect(Number(trashed.deleted_time), 'deleted_time is the time of the delete').toBeGreaterThanOrEqual(deletedAt - 60_000);
			expect(Number(trashed.deleted_time), 'deleted_time is the time of the delete').toBeLessThanOrEqual(Date.now() + 60_000);
			expect(notesTitled(dataApi, T2), 'not listed without include_deleted').toEqual([]);
			expect(notesTitled(dataApi, T2, { includeDeleted: true }).map(n => n.id), 'listed in the trash, once').toEqual([id]);
		});

		await test.step('11. network policy', async () => {
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
		});
	});
});
