// DNS-1 D1: the parser and comparison for Joplin sync items (tests/contract/support/joplinItem.ts). Joplin Server
// re-serializes notes (it appends keys such as `is_locked:`), so "the stored note equals the uploaded one" is checked
// field by field: title, body and every uploaded property.
import { describe, expect, test } from '@jest/globals';
import { compareUploadedItem, parseJoplinItem } from '../../contract/support/joplinItem.ts';

const props = [
	'id: 0123456789abcdef0123456789abcdef', 'parent_id: ', 'created_time: 2026-10-05T00:00:00.000Z', 'is_todo: 0',
	'markup_language: 1', 'deleted_time: 0', 'type_: 1',
];
const note = (title: string, body: string, lines: string[] = props): string => [title, '', body, '', ...lines].join('\n');

describe('joplinItem parser and comparison', () => {
	test('parseJoplinItem splits title, multi-line body and properties', () => {
		const parsed = parseJoplinItem(note('A title', 'line one\n\nline three: not a property', props));
		expect(parsed.title).toBe('A title');
		expect(parsed.body).toBe('line one\n\nline three: not a property');
		expect(parsed.props.get('id')).toBe('0123456789abcdef0123456789abcdef');
		expect(parsed.props.get('parent_id')).toBe('');
		expect(parsed.props.size).toBe(props.length);
	});

	test('the same text gives no differences', () => {
		const text = note('T', 'B');
		expect(compareUploadedItem(parseJoplinItem(text), parseJoplinItem(text))).toEqual({ differences: [], extraKeys: [] });
	});

	test('keys the server appended give no differences and are listed as extra keys', () => {
		const stored = note('T', 'B', [...props.slice(0, -1), 'is_locked: ', 'extracted_resource_ids: ', 'type_: 1']);
		expect(compareUploadedItem(parseJoplinItem(note('T', 'B')), parseJoplinItem(stored))).toEqual({ differences: [], extraKeys: ['is_locked', 'extracted_resource_ids'] });
	});

	test('a changed body is exactly one named difference', () => {
		expect(compareUploadedItem(parseJoplinItem(note('T', 'B')), parseJoplinItem(note('T', 'B2'))).differences).toEqual(['body']);
	});

	test('a changed title is exactly one named difference', () => {
		expect(compareUploadedItem(parseJoplinItem(note('T', 'B')), parseJoplinItem(note('T2', 'B'))).differences).toEqual(['title']);
	});

	test('a changed property value is exactly one named difference', () => {
		const changed = props.map(l => (l === 'is_todo: 0' ? 'is_todo: 1' : l));
		expect(compareUploadedItem(parseJoplinItem(note('T', 'B')), parseJoplinItem(note('T', 'B', changed))).differences).toEqual(['property is_todo']);
	});

	test('a missing property is exactly one named difference', () => {
		const missing = props.filter(l => !l.startsWith('markup_language'));
		expect(compareUploadedItem(parseJoplinItem(note('T', 'B')), parseJoplinItem(note('T', 'B', missing))).differences).toEqual(['property markup_language']);
	});
});
