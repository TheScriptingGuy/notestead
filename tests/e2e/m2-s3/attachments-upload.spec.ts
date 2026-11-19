// M2-S3 / M2-AC7a (docs/backlog/M2.md §M2-S3; docs/test-plans/M2-S3.md D4, D7, F1, F3, F6): a 5 MiB image and a 100 MiB binary are
// attached in the web UI (Actions > Attach... > Attach file), uploaded through the proxy after one web sync, and their sha256, read
// back through GET /resources/:id/file on the headless API, equals the generated file's. The account is E2EE, so the web app
// encrypts each attachment before the upload (FileV1, about 1.34x) and headless downloads and decrypts it. The files are generated
// at test time (testFiles) and given to the browser by path. Needs the real upstream bundle in the web image:
// NOTESTEAD_WEB_ARTIFACT=<CI artifact dir>.
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled, ok, pick, restGet } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebThenHeadless } from '../support/flows.ts';
import { expectStoredLocally } from '../support/localProfile.ts';
import { classifyRequests, itemContentRequests, violationLines } from '../support/network.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { allItems } from '../support/restQueries.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { serverItemContent, serverItemDigest, serverItemNames } from '../../stack/stack.ts';

// Phase bounds (D7, ruling 2026-11-12): max(3 x measured, floor), each phase bounded on its own; the test timeout bounds their sum.
// Pi measurement (meas/ac7a-meas.log, 915 s in all): attach 18.7 s and 24.0 s -> floor 2 min; web sync 422.5 s -> 21 min;
// headless sync 71.6 s -> floor 10 min; digest 4.4 s and 29.0 s -> floor 2 min.
const attachTimeoutMs = 2 * 60_000;
const webSyncTimeoutMs = 21 * 60_000;
const headlessSyncTimeoutMs = 10 * 60_000;
const digestTimeoutMs = 2 * 60_000;

test.describe('M2-S3 attachments uploaded from the web app', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC7a a 5 MiB image and a 100 MiB binary attached in the web UI are uploaded through the proxy, and their sha256 read back through GET /resources/:id/file on the headless API is equal', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork, testFiles }) => {
		await requireUpstreamBundle(stack, 'M2-S3');
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const get = restGet(dataApi);
		const run = randomBytes(4).toString('hex');
		const TA = `Notestead attachments ${run}`;
		const seedFolder = e2eeAccount.folder;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !note1) throw new Error('the account has no seeded folder and note');

		const cycle = async (label: string, opts: { webTimeoutMs?: number; headlessTimeoutMs?: number } = {}): Promise<void> => {
			const { webMs, headlessMs, healthAtReady } = await syncWebThenHeadless(app, webNetwork, stack, headlessService, opts);
			test.info().annotations.push({ type: 'cycle', description: `${label}: web ${webMs} ms, headless ${headlessMs} ms` });
			if (healthAtReady !== 'healthy') test.info().annotations.push({ type: 'health-lag', description: `${label}: podman health ${healthAtReady} while /healthz was ready` });
		};

		// One `phase` annotation per step: how long each took (D7: the phases are the measurement of record).
		const phaseStart = { at: Date.now() };
		const phase = (name: string): void => {
			test.info().annotations.push({ type: 'phase', description: `${name}: ${Date.now() - phaseStart.at} ms` });
			phaseStart.at = Date.now();
		};

		let seedFolderId = '';
		let id = '';
		const ids: Record<string, string> = {};
		const files = await test.step('0. generate the files; data level before', async () => {
			const started = Date.now();
			const image = testFiles.png(`nst-image-${run}.png`, { width: 1280, height: 1364, totalBytes: 5 * 1024 * 1024 });
			const binary = testFiles.binary(`nst-binary-${run}.bin`, 100 * 1024 * 1024);
			test.info().annotations.push({ type: 'files', description: `${image.size + binary.size} bytes generated in ${Date.now() - started} ms` });
			seedFolderId = String(ok(dataApi.get(`/notes/${note1.id}?fields=parent_id`), 'GET the seeded note').parent_id);
			expect(pick(ok(dataApi.get(`/folders/${seedFolderId}?fields=title`), 'GET the seeded folder'), ['title'])).toEqual({ title: seedFolder });
			expect(allItems(get, '/resources', 'id,title').filter(r => [image.name, binary.name].includes(String(r.title))), 'no resource with these names yet').toEqual([]);
			expect(notesTitled(dataApi, TA), 'no note with this title yet').toEqual([]);
			phase('generate');
			return { image, binary };
		});
		const { image, binary } = files;

		await test.step('1. open the web app and unlock it', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			phase('unlock');
		});

		await test.step('2. attach both in the web UI', async () => {
			await app.openFolder(seedFolder);
			await app.newNote();
			await note.typeTitle(TA);
			for (const f of [image, binary]) {
				const t = Date.now();
				await note.attachFile(f.path, attachTimeoutMs);
				ids[f.name] = await note.waitForAttachmentLink(f.name, attachTimeoutMs);
				test.info().annotations.push({ type: 'attach', description: `${f.name}: ${Date.now() - t} ms` });
			}
			await app.backToList();
			await expect(app.noteInList(TA)).toBeVisible({ timeout: 60_000 });
			// WEB-SQLITE-1: the web app's own database holds the note title and both attachments' file names before any sync
			await expectStoredLocally(webApp, TA, 'the new note\'s title');
			await expectStoredLocally(webApp, image.name, 'the attached image\'s file name');
			await expectStoredLocally(webApp, binary.name, 'the attached binary\'s file name');
			phase('attach');
		});

		await test.step('3. one web sync and one headless sync', async () => {
			await cycle('upload', { webTimeoutMs: webSyncTimeoutMs, headlessTimeoutMs: headlessSyncTimeoutMs });
			phase('upload cycle');
		});

		await test.step('4. REST: the two resources, with equal sha256', async () => {
			await expect.poll(() => notesTitled(dataApi, TA).map(n => n.id), { timeout: 60_000, intervals: [1_000] }).toHaveLength(1);
			id = String(notesTitled(dataApi, TA)[0].id);
			const res = allItems(get, `/notes/${id}/resources`, 'id,title,mime,size,file_extension').sort((a, b) => String(a.title).localeCompare(String(b.title)));
			expect(res.map(r => pick(r, ['id', 'title', 'size', 'file_extension']))).toEqual([
				{ id: ids[binary.name], title: binary.name, size: binary.size, file_extension: 'bin' },
				{ id: ids[image.name], title: image.name, size: image.size, file_extension: 'png' },
			]);
			expect(res.find(r => r.title === image.name)?.mime).toBe('image/png');
			test.info().annotations.push({ type: 'mime', description: `binary mime: ${String(res.find(r => r.title === binary.name)?.mime)}` });
			const body = String(ok(dataApi.get(`/notes/${id}?fields=body`), 'GET the note').body);
			expect(body).toContain(`![${image.name}](:/${ids[image.name]})`);
			expect(body).toContain(`[${binary.name}](:/${ids[binary.name]})`);
			for (const f of [image, binary]) {
				const t = Date.now();
				await expect.poll(() => pick(dataApi.fileDigest(ids[f.name], { timeoutMs: digestTimeoutMs }) as Record<string, unknown>, ['status', 'sha256', 'size']), { message: `the headless API returns the bytes of ${f.name}`, timeout: digestTimeoutMs + 60_000, intervals: [5_000] })
					.toEqual({ status: 200, sha256: f.sha256, size: f.size });
				test.info().annotations.push({ type: 'digest', description: `${f.name}: ${Date.now() - t} ms` });
			}
			phase('REST and digests');
		});

		await test.step('5. the server holds both encrypted', async () => {
			const names = await serverItemNames(stack, e2eeAccount);
			for (const f of [image, binary]) {
				expect(names).toContain(`.resource/${ids[f.name]}`);
				expect((await serverItemContent(stack, e2eeAccount, `${ids[f.name]}.md`)).text).toMatch(/^encryption_applied: 1$/m);
				const d = await serverItemDigest(stack, e2eeAccount, `.resource/${ids[f.name]}`, { headBytes: 5, timeoutMs: digestTimeoutMs });
				expect(d.status).toBe(200);
				expect(d.head).toBe('JED01');
				expect(d.sha256).not.toBe(f.sha256);
				expect(d.size).toBeGreaterThan(f.size);
				test.info().annotations.push({ type: 'e2ee-overhead', description: `${f.name}: ${(d.size / f.size).toFixed(3)}` });
			}
			phase('server blobs');
		});

		await test.step('6. through the proxy', async () => {
			for (const f of [image, binary]) {
				const puts = itemContentRequests(webNetwork.entries(), 'PUT', `.resource/${ids[f.name]}`);
				expect(puts.some(e => e.status === 200), `a PUT of the blob of ${f.name} succeeded through the proxy`).toBe(true);
				expect(puts.filter(e => (e.status ?? 0) >= 400).map(e => e.status), `no failed PUT of the blob of ${f.name}`).toEqual([]);
			}
			phase('proxy PUTs');
		});

		await test.step('7. network policy', async () => {
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
			phase('network policy');
		});
	});
});
