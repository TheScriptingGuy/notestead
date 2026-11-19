// M2-S3 / M2-AC8 (docs/backlog/M2.md §M2-S3; docs/test-plans/M2-S3.md D6): a note deleted in the web UI is listed in the web
// trash and in GET /notes?include_deleted=1 with deleted_time > 0; once restored in the web UI its deleted_time is 0 in the REST
// API, with the note back exactly as it was. Note 1 of the seed is the untouched control. One web sync and one headless sync
// per operation (M2-S2 D2, D3). Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir>.
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled, ok, pick, restGet } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebThenHeadless } from '../support/flows.ts';
import { expectStoredLocally } from '../support/localProfile.ts';
import { classifyRequests, violationLines } from '../support/network.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { allItems } from '../support/restQueries.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';

const fields = 'id,title,body,parent_id,deleted_time,is_conflict';

test.describe('M2-S3 trash in the web app', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });
	test.use({ e2eeSeed: { notes: 2 } });

	test('M2-AC8 a note deleted in the web UI is listed in the web trash and in GET /notes?include_deleted=1 with deleted_time > 0, and once restored in the web UI its deleted_time is 0 in the REST API', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S3');
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const get = restGet(dataApi);
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		const note2 = e2eeAccount.notes?.[1];
		if (!seedFolder || !note1 || !note2) throw new Error('the account has no seeded folder and two notes');
		const T = note2.title;

		const readNote = (id: string): Record<string, unknown> => pick(ok(dataApi.get(`/notes/${id}?fields=${fields}`), `GET /notes/${id}`), fields.split(','));
		// The AC's literal query: GET /notes?include_deleted=1.
		const withDeleted = (id: string): Record<string, unknown>[] => allItems(get, '/notes?include_deleted=1', 'id,deleted_time').filter(n => n.id === id).map(n => pick(n, ['id', 'deleted_time']));
		const cycle = async (label: string): Promise<void> => {
			const { webMs, headlessMs, healthAtReady } = await syncWebThenHeadless(app, webNetwork, stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `${label}: web ${webMs} ms, headless ${headlessMs} ms` });
			if (healthAtReady !== 'healthy') test.info().annotations.push({ type: 'health-lag', description: `${label}: podman health ${healthAtReady} while /healthz was ready` });
		};

		let before1: Record<string, unknown> = {};
		let before2: Record<string, unknown> = {};
		let seedFolderId = '';
		let deletedAt = 0;

		await test.step('0. data level before', async () => {
			before2 = readNote(note2.id);
			expect(before2).toMatchObject({ id: note2.id, title: T, deleted_time: 0, is_conflict: 0 });
			before1 = readNote(note1.id);
			seedFolderId = String(before2.parent_id);
			expect(pick(ok(dataApi.get(`/folders/${seedFolderId}?fields=title`), 'GET the seeded folder'), ['title'])).toEqual({ title: seedFolder });
			expect(withDeleted(note2.id)).toEqual([{ id: note2.id, deleted_time: 0 }]);
		});

		await test.step('1. open the web app and unlock it', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			await app.openFolder(seedFolder);
			await expect(app.noteInList(T)).toBeVisible({ timeout: 60_000 });
		});

		await test.step('2. delete note 2 to the trash', async () => {
			await app.openNote(T);
			await note.waitOpen();
			deletedAt = Date.now();
			const exit = await app.trashOpenNote(note);
			test.info().annotations.push({ type: 'trash-exit', description: exit === 'left' ? 'the app left the trashed note by itself' : 'the app stayed on the trashed note; Back pressed' });
			await expect.poll(() => app.noteInList(T).count(), { timeout: 30_000, intervals: [500] }).toBe(0);
		});

		await test.step('3. the web trash lists it, and only it of the two', async () => {
			await app.openTrash();
			await expect(app.noteInList(T)).toBeVisible({ timeout: 30_000 });
			await expect(app.noteInList(note1.title)).toHaveCount(0);
		});

		await test.step('4. cycle: deleted_time > 0 in GET /notes?include_deleted=1', async () => {
			await cycle('delete');
			await expect.poll(() => {
				const d = Number(readNote(note2.id).deleted_time);
				return d > 0 ? 'trashed' : `deleted_time ${d}`;
			}, { timeout: 60_000, intervals: [1_000] }).toBe('trashed');
			const trashed = readNote(note2.id);
			expect(trashed).toMatchObject({ title: T, body: before2.body, parent_id: seedFolderId, is_conflict: 0 });
			expect(Number(trashed.deleted_time), 'deleted_time is the time of the delete').toBeGreaterThanOrEqual(deletedAt - 60_000);
			expect(Number(trashed.deleted_time), 'deleted_time is the time of the delete').toBeLessThanOrEqual(Date.now() + 60_000);
			const listed = withDeleted(note2.id);
			expect(listed, 'listed once by include_deleted=1').toHaveLength(1);
			expect(listed[0].deleted_time).toBe(trashed.deleted_time);
			expect(notesTitled(dataApi, T), 'not in the default listing').toEqual([]);
			expect(notesTitled(dataApi, T, { includeDeleted: true }).map(n => n.id)).toEqual([note2.id]);
			expect(readNote(note1.id), 'note 1, the control, is unchanged').toEqual(before1);
		});

		await test.step('5. restore it in the web UI', async () => {
			// the trash list is still open
			await app.openNote(T);
			await note.waitOpen();
			await note.restore();
			await expect.poll(() => app.noteInList(T).count(), { timeout: 30_000, intervals: [500] }).toBe(0);
			await app.openFolder(seedFolder);
			await expect(app.noteInList(T)).toBeVisible({ timeout: 30_000 });
			// WEB-SQLITE-1: the restored note's title is still in the web app's own database before the sync
			await expectStoredLocally(webApp, T, 'the restored note\'s title');
		});

		await test.step('6. cycle: deleted_time is 0, the note is back exactly as it was', async () => {
			await cycle('restore');
			await expect.poll(() => {
				const d = Number(readNote(note2.id).deleted_time);
				return d === 0 ? 'restored' : `deleted_time ${d}`;
			}, { timeout: 60_000, intervals: [1_000] }).toBe('restored');
			expect(readNote(note2.id)).toEqual(before2);
			expect(notesTitled(dataApi, T).map(n => n.id), 'listed again, once: no conflict copy').toEqual([note2.id]);
			expect(withDeleted(note2.id)).toEqual([{ id: note2.id, deleted_time: 0 }]);
			expect(readNote(note1.id), 'note 1, the control, is unchanged').toEqual(before1);
		});

		await test.step('7. network policy', async () => {
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
		});
	});
});
