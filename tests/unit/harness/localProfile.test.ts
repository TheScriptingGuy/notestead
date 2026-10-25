// Finding an edited value in the web app's own database file (tests/e2e/support/localProfile.ts findInDatabaseFile; WEB-SQLITE-1,
// docs/test-plans/M2-S3.md WS-3). The result carries the path, never a byte of the file or the needle.
import { describe, expect, test } from '@jest/globals';
import { findInDatabaseFile } from '../../e2e/support/localProfile.ts';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(`\0\0header ${text} tail\0`, 'utf8'));

describe('stored in the database file', () => {
	test('stored-01 only a .sqlite3 file counts, never its journal or another file', () => {
		const needle = 'Notestead title abc12';
		const files = [
			{ path: '/joplin.sqlite3-journal', bytes: bytes(needle) },
			{ path: '/other.bin', bytes: bytes(needle) },
			{ path: '/notes.sqlite3.bak', bytes: bytes(needle) },
		];
		expect(findInDatabaseFile(files, needle)).toBeUndefined();
		expect(findInDatabaseFile([...files, { path: '/joplin.sqlite3', bytes: bytes(needle) }], needle)).toEqual({ file: '/joplin.sqlite3' });
		expect(findInDatabaseFile([{ path: '/joplin.sqlite3', bytes: bytes('something else') }], needle)).toBeUndefined();
	});

	test('stored-02 a UTF-8 needle with non-ASCII text is found', () => {
		const needle = 'Notestead edited note abc12 Δ ünïcödé ✓';
		expect(findInDatabaseFile([{ path: '/a/joplin.sqlite3', bytes: bytes(needle) }], needle)).toEqual({ file: '/a/joplin.sqlite3' });
		expect(findInDatabaseFile([{ path: '/a/joplin.sqlite3', bytes: bytes(needle.replace('Δ', 'D')) }], needle)).toBeUndefined();
	});

	test('stored-03 the result holds the path and nothing else, and an empty needle is no match', () => {
		const needle = 'secret needle value';
		const found = findInDatabaseFile([{ path: '/x.sqlite3', bytes: bytes(needle) }], needle);
		expect(Object.keys(found ?? {})).toEqual(['file']);
		expect(JSON.stringify(found)).not.toContain('needle');
		expect(findInDatabaseFile([{ path: '/x.sqlite3', bytes: bytes(needle) }], '')).toBeUndefined();
	});
});
