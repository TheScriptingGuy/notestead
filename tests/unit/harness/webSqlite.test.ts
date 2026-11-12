// Recognising a real browser SQLite failure in a test's console (tests/e2e/support/webSqlite.ts; WEB-SQLITE-1, docs/test-plans/
// M2-S3.md R1/WS-1). A failure is named by its kind, rc and the statement's verb and table, never by the SQL, which can hold
// note content. The lines are browser-console.log lines: `<ISO> [<level>] <message>`.
import { describe, expect, test } from '@jest/globals';
import { estimatePageChoice, sqliteFailureLines, sqliteFailures } from '../../e2e/support/webSqlite.ts';
import { classifyWorkerMessage } from '../../e2e/support/sqliteFault.ts';

const at = '2026-10-25T08:00:00.000Z';
const line = (level: string, message: string): string => `${at} [${level}] ${message}`;

describe('web sqlite failures', () => {
	test('sql-01 a step with an error code other than 0 or 1 is a failure, named by verb and table', () => {
		const r = sqliteFailures([line('log', 'unrelated'), line('warning', 'sqlite3_step() rc= 10 SQLITE_IOERR SQL = CREATE TABLE migrations (id INT PRIMARY KEY, created_time INT)')]);
		expect(r).toEqual([{ rc: 10, kind: 'step', statement: 'CREATE TABLE migrations', line: 2 }]);
	});

	test('sql-02 the statement is its verb and table only, never the WHERE or the values', () => {
		const r = sqliteFailures([line('warning', "sqlite3_step() rc= -1 undefined SQL = DELETE FROM settings WHERE key IN ('a','b')")]);
		expect(r).toEqual([{ rc: -1, kind: 'step', statement: 'DELETE settings', line: 1 }]);
		expect(sqliteFailures([line('warning', "sqlite3_step() rc= 5 SQLITE_BUSY SQL = INSERT INTO notes (id, title) VALUES ('x', 'y')")])[0].statement).toBe('INSERT notes');
		expect(sqliteFailures([line('warning', "sqlite3_step() rc= 5 SQLITE_BUSY SQL = UPDATE notes SET title = 'z' WHERE id = 'x'")])[0].statement).toBe('UPDATE notes');
		expect(sqliteFailures([line('warning', 'sqlite3_step() rc= 10 SQLITE_IOERR SQL = COMMIT')])[0].statement).toBe('COMMIT');
	});

	test('sql-03 the startup spellfix line is not a failure, the same message at another code is', () => {
		const spellfix = 'sqlite3_step() rc= 1 SQLITE_ERROR SQL = CREATE VIRTUAL TABLE notes_spellfix USING spellfix1';
		expect(sqliteFailures([line('warning', spellfix)])).toEqual([]);
		expect(sqliteFailures([line('warning', spellfix.replace('rc= 1 SQLITE_ERROR', 'rc= 10 SQLITE_IOERR'))])).toEqual([
			{ rc: 10, kind: 'step', statement: 'CREATE VIRTUAL TABLE notes_spellfix', line: 1 },
		]);
	});

	test('sql-04 rc 1 on a rollback and rc 0 are not failures', () => {
		expect(sqliteFailures([
			line('warning', 'sqlite3_step() rc= 1 SQLITE_ERROR SQL = ROLLBACK'),
			line('warning', 'sqlite3_step() rc= 0 SQLITE_OK SQL = SELECT 1'),
		])).toEqual([]);
	});

	test('sql-05 a failed settings save is a failure of kind save', () => {
		const r = sqliteFailures([line('error', 'models/Setting: Could not save settings {type: error, dbId: 1, messageId: exec#2297}')]);
		expect(r).toEqual([{ rc: null, kind: 'save', statement: 'settings', line: 1 }]);
	});

	test('sql-06 the openDatabase startup failure is a failure of kind startup', () => {
		const r = sqliteFailures([line('error', 'root: Startup failure during task: buildStartupTasks/openDatabase Error: boom')]);
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ rc: null, kind: 'startup', line: 1 });
	});

	test('sql-07 no result and no printed line holds the SQL text or a bound value', () => {
		const lines = [
			line('warning', "sqlite3_step() rc= 10 SQLITE_IOERR SQL = INSERT INTO notes (title) VALUES ('Notestead secret title abc')"),
			line('warning', "sqlite3_step() rc= 10 SQLITE_IOERR SQL = UPDATE notes SET title = 'Notestead secret title abc' WHERE id = 'q'"),
			line('warning', "sqlite3_step() rc= 10 SQLITE_IOERR SQL = DELETE FROM notes WHERE title = 'Notestead secret title abc'"),
			line('error', 'models/Note: Could not save note {title: Notestead secret title abc}'),
		];
		const r = sqliteFailures(lines);
		expect(r).toHaveLength(4);
		expect(JSON.stringify(r)).not.toContain('secret title');
		expect(sqliteFailureLines(r).join('\n')).not.toContain('secret title');
		expect(sqliteFailureLines(r)[0]).toBe('SQLite step: rc 10, INSERT notes (console line 1)');
	});

	test('sql-08 the app page is used for the storage estimate when it is on the web origin', () => {
		expect(estimatePageChoice('http://127.0.0.1:41234/', 'http://127.0.0.1:41234')).toBe('app');
	});

	test('sql-09 any other page (blank, none, another port, a data URL) gets a same-origin probe', () => {
		for (const url of ['about:blank', undefined, 'http://127.0.0.1:41235/', 'data:text/html,x']) {
			expect(`${String(url)} -> ${estimatePageChoice(url, 'http://127.0.0.1:41234')}`).toBe(`${String(url)} -> probe`);
		}
	});

	// The message classifier of the L20 characterisation's fault script: sqlite-wasm's worker-1 message shape is
	// { type: 'exec', args: { sql } } (docs/test-plans/M2-S3-work-orders.md WO-29).
	const exec = (sql: string): unknown => ({ type: 'exec', messageId: 'exec#1', dbId: 'db#1', args: { sql, bind: null } });

	test('wsq-01 a settings DELETE is classified, whatever its case', () => {
		expect(classifyWorkerMessage(exec('DELETE FROM settings WHERE key IN (?)'))).toBe('settings-delete');
		expect(classifyWorkerMessage(exec('  delete from SETTINGS where key in (?, ?)'))).toBe('settings-delete');
	});

	test('wsq-02 a note title UPDATE is classified', () => {
		expect(classifyWorkerMessage(exec('UPDATE notes SET title = ?, updated_time = ? WHERE id = ?'))).toBe('notes-title-update');
		expect(classifyWorkerMessage(exec('update Notes set Title = ? where id = ?'))).toBe('notes-title-update');
		// the app's real statement quotes its identifiers with backticks
		expect(classifyWorkerMessage(exec('UPDATE `notes` SET `title`=?, `updated_time`=?, `user_updated_time`=? WHERE `id` = ?'))).toBe('notes-title-update');
		expect(classifyWorkerMessage(exec('DELETE FROM `settings` WHERE key IN (\'a\')'))).toBe('settings-delete');
		expect(classifyWorkerMessage(exec('UPDATE notes SET body = ? WHERE id = ?'))).toBe('other');
	});

	test('wsq-03 BEGIN is classified; anything else and a non-object are other', () => {
		expect(classifyWorkerMessage(exec('BEGIN TRANSACTION'))).toBe('begin');
		expect(classifyWorkerMessage(exec('COMMIT'))).toBe('other');
		expect(classifyWorkerMessage(exec('SELECT 1'))).toBe('other');
		expect(classifyWorkerMessage({ type: 'open', args: { filename: 'x' } })).toBe('other');
		for (const bad of [null, undefined, 'BEGIN', 5, { type: 'exec' }, { type: 'exec', args: { sql: 7 } }]) expect(classifyWorkerMessage(bad)).toBe('other');
	});
});
