// M2-S3 / M2-AC6 and its NEG (docs/backlog/M2.md §M2-S3; docs/test-plans/M2-S3.md D3): a note created through the headless Data
// API with a unique word in its body is found by the web UI's search after a headless sync (the upload) and a web sync (the
// download); and a word that is in no note returns no results. Upstream runs a query only when its text changes and indexes a
// synced note about 10 s later, so the search is retyped like a user until the result shows (F2). Needs the real upstream bundle
// in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir>.
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled, ok, pick, restGet } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebOnce } from '../support/flows.ts';
import { classifyRequests, itemContentRequests, violationLines } from '../support/network.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { allItems } from '../support/restQueries.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { typeLikeUser } from '../support/typeLikeUser.ts';
import { serverItemContent, syncHeadlessOnce } from '../../stack/stack.ts';

test.describe('M2-S3 search in the web app', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC6 a note created through the headless API with a unique word in its body is found by the web UI search after a headless sync and a web sync, and (NEG) a word in no note returns no results', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S3');
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const get = restGet(dataApi);
		const run = randomBytes(4).toString('hex');
		const TS = `Notestead search target ${run}`;
		const W = `nstword${randomBytes(5).toString('hex')}`;
		const BODY = `This body holds the unique word ${W} for M2-AC6.`;
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');

		let seedFolderId = '';
		let id = '';
		let mark = 0;

		await test.step('0. data level before', async () => {
			seedFolderId = String(ok(dataApi.get(`/notes/${note1.id}?fields=parent_id`), 'GET the seeded note').parent_id);
			expect(pick(ok(dataApi.get(`/folders/${seedFolderId}?fields=title`), 'GET the seeded folder'), ['title'])).toEqual({ title: seedFolder });
			expect(notesTitled(dataApi, TS)).toEqual([]);
		});

		await test.step('1. open the web app and unlock it', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
		});

		await test.step('2. headless: create the note', async () => {
			mark = webNetwork.entries().length;
			// a test-made body: plain words, no file:/http(s):/data: URL (CLAUDE.md security rules)
			const r = dataApi.request('POST', '/notes', { title: TS, body: BODY, parent_id: seedFolderId });
			id = String(ok(r, 'POST /notes').id);
			expect(pick(ok(dataApi.get(`/notes/${id}?fields=id,title,body,parent_id`), 'GET the new note'), ['id', 'title', 'body', 'parent_id'])).toEqual({ id, title: TS, body: BODY, parent_id: seedFolderId });
		});

		await test.step('3. one headless sync: the server holds it encrypted', async () => {
			const { durationMs } = await syncHeadlessOnce(stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `headless: ${durationMs} ms` });
			const onServer = await serverItemContent(stack, e2eeAccount, `${id}.md`);
			expect(onServer.status, 'GET the note from the server').toBe(200);
			expect(onServer.text).toMatch(/^encryption_applied: 1$/m);
			expect(onServer.text.includes(W), 'the word is not in clear on the server').toBe(false);
			expect(onServer.text.includes(TS), 'the title is not in clear on the server').toBe(false);
		});

		await test.step('4. one web sync: the web app downloaded it through the proxy', async () => {
			const { durationMs } = await syncWebOnce(app, webNetwork);
			test.info().annotations.push({ type: 'cycle', description: `web: ${durationMs} ms` });
			expect(itemContentRequests(webNetwork.entries().slice(mark), 'GET', `${id}.md`).some(e => e.status === 200), 'the web app GET the note\'s content (200) through the proxy').toBe(true);
		});

		const search = await test.step('5. the web search finds it by the word in its body', async () => {
			const s = await app.openSearch();
			const found = await s.searchUntilFound(W, TS);
			test.info().annotations.push({ type: 'search', description: `${found.attempts} attempt(s), ${found.ms} ms` });
			await s.result(TS).click();
			await note.waitOpen();
			await expect.poll(async () => ((await app.frameText()).includes(W) ? 'shown' : 'not shown'), { message: 'the opened result shows the word in its body', timeout: 60_000, intervals: [500] }).toBe('shown');
			await s.backFromNote();
			await expect(s.field()).toHaveValue(W);
			return s;
		});

		await test.step('6. NEG: a word in no note returns no results', async () => {
			await typeLikeUser(search.field(), `${W}x`);
			await expect(search.result(TS), 'the result for the word is gone once the query for the NEG word has run').toHaveCount(0, { timeout: 30_000 });
			await expect(search.field()).toHaveValue(`${W}x`);
			const titles = [...new Set(allItems(get, '/notes?include_conflicts=1&include_deleted=1', 'id,title').map(n => String(n.title)))];
			expect(titles.length).toBeGreaterThanOrEqual(2);
			const listed: string[] = [];
			for (const t of titles) if ((await search.result(t).count()) > 0) listed.push(t);
			expect(listed, 'no note of the account is listed for a word that is in no note').toEqual([]);
			test.info().annotations.push({ type: 'neg', description: `${titles.length} note titles checked` });
			await search.close();
		});

		await test.step('7. network policy', async () => {
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
		});
	});
});
