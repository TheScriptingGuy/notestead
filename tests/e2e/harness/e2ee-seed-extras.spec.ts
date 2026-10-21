// The e2eeAccount seed extras (docs/test-plans/M2-S2.md D7; ADR-0007 §Fixtures, A2): with e2eeSeed.extras, the other device
// also seeds a to-do with todo_due, a tag on note 1 and a text attachment on a note of its own. They reach the headless
// REST API decrypted, and the server holds them encrypted.
import { createHash } from 'node:crypto';
import { ok, pick, restGet } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { allItems, noteTagTitles, tagNoteIds, tagsTitled } from '../support/restQueries.ts';
import { serverItemContent, serverItemNames } from '../../stack/stack.ts';
// RED only: a namespace import, because a named import of an export that does not exist yet fails at module link time,
// before step 1 can show the missing feature.
import * as stackModule from '../../stack/stack.ts';

test.describe('M2-S2 e2eeAccount seed extras', () => {
	test.use({ e2eeSeed: { notes: 1, extras: true } });

	test('M2-S2-SEED-01 the seeded to-do with todo_due, the seeded tag and the attachment reach the headless REST API decrypted, and the server holds them encrypted', async ({ stack, e2eeAccount, dataApi }) => {
		const get = restGet(dataApi);
		const todo = e2eeAccount.seedTodo;
		const tag = e2eeAccount.seedTagTitle;
		const att = e2eeAccount.seedAttachment;
		const note1 = e2eeAccount.notes?.[0];
		let attachmentResource = '';

		await test.step('1. the account records the extras', () => {
			expect(todo, 'the account records the seeded to-do').toBeDefined();
			expect(tag, 'the account records the seeded tag').toBeDefined();
			expect(att, 'the account records the seeded attachment').toBeDefined();
			expect(note1, 'the account records note 1').toBeDefined();
		});

		await test.step('2. the to-do has is_todo and todo_due, in the folder of note 1', async () => {
			const parentId = ok(dataApi.get(`/notes/${note1!.id}?fields=parent_id`), 'GET note 1').parent_id;
			const fields = 'id,title,is_todo,todo_due,todo_completed,parent_id';
			expect(pick(ok(dataApi.get(`/notes/${todo!.id}?fields=${fields}`), 'GET the seeded to-do'), fields.split(','))).toEqual({
				id: todo!.id, title: todo!.title, is_todo: 1, todo_due: stackModule.seedTodoDue, todo_completed: 0, parent_id: parentId,
			});
		});

		await test.step('3. the tag exists once and is on note 1 only', async () => {
			const tags = tagsTitled(get, tag!);
			expect(tags, 'exactly one tag with the seeded title').toHaveLength(1);
			expect(tagNoteIds(get, String(tags[0].id))).toEqual([note1!.id]);
			expect(noteTagTitles(get, note1!.id)).toEqual([tag]);
		});

		await test.step('4. the attachment: one resource, linked from the note, with the seeded bytes', async () => {
			const resources = allItems(get, `/notes/${att!.noteId}/resources`, 'id,title,size');
			expect(resources, 'the attachment note has exactly one resource').toHaveLength(1);
			attachmentResource = String(resources[0].id);
			expect(String(ok(dataApi.get(`/notes/${att!.noteId}?fields=body`), 'GET the attachment note').body)).toContain(`(:/${attachmentResource})`);
			const file = dataApi.get(`/resources/${attachmentResource}/file`);
			expect(file.error).toBeUndefined();
			expect(file.status).toBe(200);
			expect(typeof file.body).toBe('string');
			const text = file.body as string;
			expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(att!.sha256);
			expect(Buffer.byteLength(text)).toBe(att!.size);
		});

		await test.step('5. the server holds the resource and the to-do encrypted', async () => {
			const names = await serverItemNames(stack, e2eeAccount);
			expect(names, 'the server lists the attachment as a resource item').toContain(`.resource/${attachmentResource}`);
			expect(names, 'the server lists the to-do').toContain(`${todo!.id}.md`);
			const resource = await serverItemContent(stack, e2eeAccount, `.resource/${attachmentResource}`);
			expect(resource.status).toBe(200);
			expect(resource.text.includes('Notestead seeded attachment'), 'the attachment text is not in clear on the server').toBe(false);
			const todoItem = await serverItemContent(stack, e2eeAccount, `${todo!.id}.md`);
			expect(todoItem.status).toBe(200);
			expect(todoItem.text).toMatch(/^encryption_applied: 1$/m);
			expect(todoItem.text.includes(e2eeAccount.seedTag!), 'no seeded text in clear on the server').toBe(false);
		});
	});
});
