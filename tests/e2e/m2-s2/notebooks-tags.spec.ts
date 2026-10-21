// M2-S2 / M2-AC4 (docs/backlog/M2.md §M2-S2; docs/test-plans/M2-S2.md): notebooks are created, renamed and nested, and tags are
// added to a note, removed from it and renamed, all in the web UI. After one web sync and one headless sync per step, the
// headless REST API shows the same ids with the new values in /folders, /tags and /tags/:id/notes (plan D4). The tag the
// other device seeded on the same note must survive the web app's tag changes untouched (seed extras, D7). The account is an
// unlocked E2EE account (D1, L18). Nesting is done from the child's edit screen, where the parent is listed (F3).
// Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { ok, pick, restGet } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebThenHeadless } from '../support/flows.ts';
import { classifyRequests, violationLines } from '../support/network.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import { allItems, foldersTitled, noteTagTitles, tagNoteIds, tagsTitled } from '../support/restQueries.ts';

test.describe('M2-S2 notebooks and tags in the web app', () => {
	test.describe.configure({ timeout: 25 * 60_000 });
	test.use({ e2eeSeed: { notes: 1, extras: true } });

	test('M2-AC4 notebooks created, renamed and nested, and tags added, removed and renamed in the web UI are reflected in /folders, /tags and /tags/:id/notes', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S2');
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const get = restGet(dataApi);
		const run = randomBytes(4).toString('hex');
		const P = `Notestead parent ${run}`;
		const P2 = `Notestead renamed parent ${run}`;
		const C = `Notestead child ${run}`;
		const A = `nst-a-${run}`;
		const B = `nst-b-${run}`;
		const B2 = `nst-b-renamed-${run}`;
		const seedFolder = e2eeAccount.folder;
		const seedTag = e2eeAccount.seedTagTitle;
		const note1 = e2eeAccount.notes?.[0];
		if (!seedFolder || !seedTag || !note1) throw new Error('the account has no seeded folder, seed tag and note (e2eeSeed.extras)');

		const cycle = async (label: string): Promise<void> => {
			const { webMs, headlessMs } = await syncWebThenHeadless(app, webNetwork, stack, headlessService);
			test.info().annotations.push({ type: 'cycle', description: `${label}: web ${webMs} ms, headless ${headlessMs} ms` });
		};

		let seedTagId = '';
		let note1Before: Record<string, unknown> = {};
		let pId = '';
		let cId = '';
		let aId = '';
		let bId = '';

		await test.step('0. data level before: note 1 carries only the device\'s seed tag', async () => {
			expect(noteTagTitles(get, note1.id)).toEqual([seedTag]);
			const seedTags = tagsTitled(get, seedTag);
			expect(seedTags, 'exactly one seed tag').toHaveLength(1);
			seedTagId = String(seedTags[0].id);
			note1Before = pick(ok(dataApi.get(`/notes/${note1.id}?fields=id,title,body,parent_id`), 'GET note 1'), ['id', 'title', 'body', 'parent_id']);
		});

		await test.step('1. open the web app and unlock it', async () => {
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
		});

		await test.step('2. create two notebooks', async () => {
			await app.createNotebook(P);
			await app.createNotebook(C);
		});

		await test.step('3. add two tags to note 1', async () => {
			await app.openFolder(seedFolder);
			await app.openNote(note1.title);
			await note.waitOpen();
			const tags = await note.openTags();
			await tags.addNew(A);
			await tags.addNew(B);
			await tags.apply();
			await app.backToList();
		});

		await test.step('4. cycle: the notebooks and the tags as created', async () => {
			await cycle('create');
			await expect.poll(() => foldersTitled(get, P).length, { timeout: 60_000, intervals: [1_000] }).toBe(1);
			const parents = foldersTitled(get, P);
			const children = foldersTitled(get, C);
			expect(children, 'exactly one child notebook').toHaveLength(1);
			expect(parents[0].parent_id, 'the parent is top-level').toBe('');
			expect(children[0].parent_id, 'the child is top-level before it is nested').toBe('');
			pId = String(parents[0].id);
			cId = String(children[0].id);
			const tagsA = tagsTitled(get, A);
			const tagsB = tagsTitled(get, B);
			expect(tagsA, 'exactly one tag A').toHaveLength(1);
			expect(tagsB, 'exactly one tag B').toHaveLength(1);
			expect(tagsTitled(get, seedTag), 'the seed tag is still there, once').toHaveLength(1);
			aId = String(tagsA[0].id);
			bId = String(tagsB[0].id);
			expect(tagNoteIds(get, aId)).toEqual([note1.id]);
			expect(tagNoteIds(get, bId)).toEqual([note1.id]);
			expect(noteTagTitles(get, note1.id)).toEqual([A, B, seedTag].sort());
		});

		await test.step('5. rename the parent, nest the child, remove one tag and rename the other', async () => {
			const parentScreen = await app.editNotebook(P);
			await parentScreen.rename(P2);
			await parentScreen.save();
			await expect(app.notesHeading(P2)).toBeVisible();

			const childScreen = await app.editNotebook(C);
			await childScreen.setParent('Select parent notebook', P2);
			await childScreen.save();

			// Upstream lists a parent notebook expanded unless its id is in collapsedFolderIds (empty at start), and its "Expand"
			// button is a toggle (aria-pressed): the nested child shows at (level 1) under the expanded parent.
			// The collapse shows the level-1 child belongs to this parent (plan §Planner review, O2).
			await app.openSidebar();
			const toggle = app.expandFolder(P2);
			await expect(toggle, 'the parent notebook starts expanded').toHaveAttribute('aria-pressed', 'true');
			await expect(app.folderInSideMenu(C, 1), 'the child shows at level 1 under the expanded parent').toBeVisible();
			await toggle.click();
			await expect(toggle, 'collapsed').toHaveAttribute('aria-pressed', 'false');
			await expect(app.folderInSideMenu(C, 1), 'the child is hidden under the collapsed parent').toHaveCount(0);
			await toggle.click();
			await expect(toggle, 'expanded again').toHaveAttribute('aria-pressed', 'true');
			await expect(app.folderInSideMenu(C, 1)).toBeVisible();
			await app.closeSidebar();

			await app.openFolder(seedFolder);
			await app.openNote(note1.title);
			await note.waitOpen();
			const tags = await note.openTags();
			await tags.remove(A);
			await tags.apply();
			await app.backToList();

			const tagsScreen = await app.openTagsScreen();
			await tagsScreen.rename(B, B2);
			await app.backToList();
		});

		await test.step('6. cycle: the same ids renamed and nested; tag A off note 1; the device\'s tag untouched', async () => {
			await cycle('change');
			const mine = (): Record<string, { title: unknown; parent_id: unknown }> => Object.fromEntries(
				allItems(get, '/folders', 'id,title,parent_id').filter(f => f.id === pId || f.id === cId).map(f => [String(f.id), { title: f.title, parent_id: f.parent_id }]));
			await expect.poll(mine, { timeout: 60_000, intervals: [1_000] })
				.toEqual({ [pId]: { title: P2, parent_id: '' }, [cId]: { title: C, parent_id: pId } });
			expect(foldersTitled(get, P), 'no notebook with the old name').toEqual([]);
			expect(tagNoteIds(get, aId), 'tag A is off note 1').toEqual([]);
			expect(tagsTitled(get, B), 'no tag with the old name').toEqual([]);
			expect(tagsTitled(get, B2).map(t => t.id), 'the same tag, renamed').toEqual([bId]);
			expect(tagNoteIds(get, bId)).toEqual([note1.id]);
			expect(tagsTitled(get, seedTag).map(t => t.id), 'the device\'s tag keeps its id').toEqual([seedTagId]);
			expect(tagNoteIds(get, seedTagId), 'and its note').toEqual([note1.id]);
			expect(noteTagTitles(get, note1.id)).toEqual([B2, seedTag].sort());
			expect(pick(ok(dataApi.get(`/notes/${note1.id}?fields=id,title,body,parent_id`), 'GET note 1'), ['id', 'title', 'body', 'parent_id']), 'note 1 itself is unchanged: the web app changed only its tags').toEqual(note1Before);
		});

		await test.step('7. network policy', async () => {
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
		});
	});
});
