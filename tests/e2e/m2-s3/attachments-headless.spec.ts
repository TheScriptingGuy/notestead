// M2-S3 / M2-AC7b (docs/backlog/M2.md §M2-S3; docs/test-plans/M2-S3.md D5, F4): an image attached through the headless Data API is
// shown in the web UI with the same bytes, after a headless sync (the upload) and a web sync (the download). "Viewable" is proven
// by the bytes: the note viewer's <img> is decoded from a blob: URL, and the bytes of that URL hash to the file's sha256. Needs the
// real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir>.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { ok, pick, restGet } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebOnce } from '../support/flows.ts';
import { classifyRequests, itemContentRequests, violationLines } from '../support/network.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { allItems } from '../support/restQueries.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { serverItemContent, serverItemDigest, serverItemNames, syncHeadlessOnce } from '../../stack/stack.ts';

test.describe('M2-S3 an attachment made through the headless API', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC7b an image attached through the headless API is shown in the web UI with the same bytes after a headless sync and a web sync', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork, testFiles }) => {
		await requireUpstreamBundle(stack, 'M2-S3');
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const get = restGet(dataApi);
		const run = randomBytes(4).toString('hex');
		const TN = `Notestead headless attachment ${run}`;
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');

		let seedFolderId = '';
		let mark = 0;
		let R = '';
		let N = '';
		const img = testFiles.png(`nst-headless-${run}.png`, { width: 96, height: 64 });

		await test.step('0. data level before', async () => {
			seedFolderId = String(ok(dataApi.get(`/notes/${note1.id}?fields=parent_id`), 'GET the seeded note').parent_id);
			expect(pick(ok(dataApi.get(`/folders/${seedFolderId}?fields=title`), 'GET the seeded folder'), ['title'])).toEqual({ title: seedFolder });
		});

		await test.step('1. open the web app and unlock it', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
		});

		await test.step('2. headless: the attachment and its note', async () => {
			mark = webNetwork.entries().length;
			const r = dataApi.createResource({ title: img.name, fileName: img.name, mime: 'image/png', bytes: readFileSync(img.path) });
			R = String((ok(r, 'POST /resources') as { id: unknown }).id);
			expect(pick(ok(dataApi.get(`/resources/${R}?fields=id,title,mime,size,file_extension`), 'GET the resource'), ['id', 'title', 'mime', 'size', 'file_extension'])).toEqual({ id: R, title: img.name, mime: 'image/png', size: img.size, file_extension: 'png' });
			// the positive control of the read-back path
			expect(pick(dataApi.fileDigest(R) as Record<string, unknown>, ['status', 'sha256', 'size'])).toEqual({ status: 200, sha256: img.sha256, size: img.size });
			// a test-made body: plain words and a :/<id> link, no file:/http(s):/data: URL (CLAUDE.md security rules)
			N = String(ok(dataApi.request('POST', '/notes', { title: TN, parent_id: seedFolderId, body: `Attachment made through the headless API ${run}\n\n![${img.name}](:/${R})` }), 'POST /notes').id);
			expect(allItems(get, `/notes/${N}/resources`, 'id').map(x => x.id)).toEqual([R]);
			// NEG (data): the server has neither before the headless sync
			const names = await serverItemNames(stack, e2eeAccount);
			expect(names).not.toContain(`.resource/${R}`);
			expect(names).not.toContain(`${R}.md`);
		});

		await test.step('3. one headless sync: the server holds the attachment encrypted', async () => {
			const { durationMs } = await syncHeadlessOnce(stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `headless: ${durationMs} ms` });
			const names = await serverItemNames(stack, e2eeAccount);
			expect(names).toContain(`.resource/${R}`);
			expect(names).toContain(`${R}.md`);
			expect(names).toContain(`${N}.md`);
			const meta = await serverItemContent(stack, e2eeAccount, `${R}.md`);
			expect(meta.text).toMatch(/^encryption_applied: 1$/m);
			expect(meta.text.includes(img.name), 'the file name is not in clear on the server').toBe(false);
			const d = await serverItemDigest(stack, e2eeAccount, `.resource/${R}`, { headBytes: 5 });
			expect(d.status).toBe(200);
			expect(d.head).toBe('JED01');
			expect(d.sha256).not.toBe(img.sha256);
			expect(d.size).toBeGreaterThan(img.size);
			test.info().annotations.push({ type: 'e2ee-overhead', description: `${(d.size / img.size).toFixed(3)} for ${img.size} B` });
		});

		await test.step('4. one web sync', async () => {
			const { durationMs } = await syncWebOnce(app, webNetwork);
			test.info().annotations.push({ type: 'cycle', description: `web: ${durationMs} ms` });
		});

		await test.step('5. the web UI shows the image with the same bytes', async () => {
			await app.openFolder(seedFolder);
			await app.openNote(TN);
			await note.waitOpen();
			const shownAt = Date.now();
			await expect.poll(() => note.viewerImage(R), { message: 'the viewer shows the attachment decoded from a blob: URL', timeout: 180_000, intervals: [1_000] })
				.toEqual({ found: true, complete: true, naturalWidth: 96, naturalHeight: 64, scheme: 'blob:', placeholder: false });
			test.info().annotations.push({ type: 'viewer', description: `viewer: ${Date.now() - shownAt} ms` });
			const bytes = await note.viewerImageBytes(R);
			expect({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 'the bytes the web UI shows are the file\'s').toEqual({ size: img.size, sha256: img.sha256 });
			expect(itemContentRequests(webNetwork.entries().slice(mark), 'GET', `.resource/${R}`).some(e => e.status === 200), 'the blob came through the proxy').toBe(true);
			await app.backToList();
		});

		await test.step('6. network policy', async () => {
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
		});
	});
});
