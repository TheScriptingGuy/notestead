// Recognising a real browser SQLite failure in a test's console (tests/e2e/support/webSqlite.ts; WEB-SQLITE-1, docs/test-plans/
// M2-S3.md R1/WS-1). A failure is named by its kind, rc and the statement's verb and table, never by the SQL, which can hold
// note content. The lines are browser-console.log lines: `<ISO> [<level>] <message>`.
import { describe, expect, test } from '@jest/globals';
import { estimatePageChoice, occurrenceRecord, sqliteFailureLines, sqliteFailures } from '../../e2e/support/webSqlite.ts';
import { batchRolledBack, classifyWorkerMessage, releaseReady } from '../../e2e/support/sqliteFault.ts';

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

	// When WSQ-01 releases the held settings batch (WO-29a): the full title is inside the transaction and the save queue has been
	// quiet for 1.5 s (3 x upstream's 500 ms AsyncActionQueue).
	const held = { kind: 'held' as const, t: 1_000, fullTitle: false };
	const update = (t: number, fullTitle: boolean): { kind: 'update-seen'; t: number; fullTitle: boolean } => ({ kind: 'update-seen', t, fullTitle });

	test('wsq-04 a partial title is never enough, whatever the time', () => {
		for (const now of [1_001, 3_000, 60_000, 1_000_000]) expect(`${now} ${releaseReady([held, update(2_000, false)], now)}`).toBe(`${now} wait`);
		expect(releaseReady([held], 100_000)).toBe('wait');
	});

	test('wsq-05 the full title releases after the quiet window', () => {
		expect(releaseReady([held, update(2_000, true)], 2_000 + 1_499)).toBe('wait');
		expect(releaseReady([held, update(2_000, true)], 2_000 + 1_500)).toBe('release');
		// an update before the hold is not inside the held batch
		expect(releaseReady([update(500, true), held], 100_000)).toBe('wait');
	});

	test('wsq-06 a later update, full or not, restarts the quiet window', () => {
		for (const full of [true, false]) {
			const events = [held, update(2_000, true), update(3_000, full)];
			expect(`${full} ${releaseReady(events, 3_000 + 1_499)}`).toBe(`${full} wait`);
			expect(`${full} ${releaseReady(events, 3_000 + 1_500)}`).toBe(`${full} release`);
		}
		expect(releaseReady([held, update(2_000, true)], 2_100, 100)).toBe('release');
	});

	// Assertion (a) of WSQ-01/02 from the worker's replies, not from upstream's log line (WO-29b): the injected statement's reply is
	// an error, and a ROLLBACK went to the worker after the release.
	type RollbackEvent = { kind: 'begin' | 'held' | 'released' | 'injected-reply' | 'rollback'; t: number; error?: boolean };
	const ev = (kind: RollbackEvent['kind'], t: number, error?: boolean): RollbackEvent => ({ kind, t, ...(error === undefined ? {} : { error }) });

	test('wsq-07 held, released, an error reply and a rollback is a rolled-back batch', () => {
		expect(batchRolledBack([ev('begin', 1), ev('held', 2), ev('released', 3), ev('injected-reply', 4, true), ev('rollback', 5)])).toBe('yes');
	});

	test('wsq-08 an injected statement that did not fail is named', () => {
		expect(batchRolledBack([ev('begin', 1), ev('held', 2), ev('released', 3), ev('injected-reply', 4, false), ev('rollback', 5)])).toMatch(/the injected statement did not fail/);
	});

	test('wsq-09 no ROLLBACK after the release is named, and one before the hold does not count', () => {
		expect(batchRolledBack([ev('begin', 1), ev('held', 2), ev('released', 3), ev('injected-reply', 4, true)])).toMatch(/no ROLLBACK after the release/);
		expect(batchRolledBack([ev('rollback', 1), ev('held', 2), ev('released', 3), ev('injected-reply', 4, true)])).toMatch(/no ROLLBACK after the release/);
		expect(batchRolledBack([ev('held', 2), ev('rollback', 2.5), ev('released', 3), ev('injected-reply', 4, true)])).toMatch(/no ROLLBACK after the release/);
	});

	// L20 occurrence records (L20 tie 2026-11-13): the database the failing statement ran on, whether startup failed, and whether
	// the failure qualifies for the tie (only rc -1 or 10, never the spellfix line, never a lone "Could not save").
	const lineAt = (sec: number, level: string, message: string): string => `2026-11-13T10:00:${String(sec).padStart(2, '0')}.000Z [${level}] ${message}`;
	const records = (lines: string[]): ReturnType<typeof occurrenceRecord> => occurrenceRecord(sqliteFailures(lines), lines);

	test('sql-10 a read at rc -1 is a qualifying occurrence on the main database, with no startup failure', () => {
		const r = records([lineAt(1, 'warning', 'sqlite3_step() rc= -1 undefined SQL = SELECT child.id FROM folders AS child')]);
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ rc: -1, statement: 'SELECT folders', db: 'main', startupFailed: false, qualifies: true });
	});

	test('sql-11 a COMMIT at rc -1 followed within 2 s by the openDatabase startup failure is main, startup failed', () => {
		const r = records([
			lineAt(1, 'warning', 'sqlite3_step() rc= -1 undefined SQL = COMMIT'),
			lineAt(2, 'error', 'root: Startup failure during task: buildStartupTasks/openDatabase'),
		]);
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ rc: -1, statement: 'COMMIT', db: 'main', startupFailed: true, qualifies: true });
	});

	test('sql-12 the logs table is the log database, and a bare COMMIT with no startup line is unknown, never guessed', () => {
		expect(records([lineAt(1, 'warning', 'sqlite3_step() rc= -1 undefined SQL = INSERT INTO logs (`source`, `level`) VALUES (?, ?)')])[0]).toMatchObject({ db: 'log', startupFailed: false, qualifies: true });
		expect(records([lineAt(1, 'warning', 'sqlite3_step() rc= -1 undefined SQL = COMMIT')])[0]).toMatchObject({ db: 'unknown', startupFailed: false, qualifies: true });
		// a startup line more than 2 s later does not attribute the COMMIT
		expect(records([lineAt(1, 'warning', 'sqlite3_step() rc= -1 undefined SQL = COMMIT'), lineAt(5, 'error', 'root: Startup failure during task: buildStartupTasks/openDatabase')])[0]).toMatchObject({ db: 'unknown', startupFailed: true });
	});

	test('sql-13 rc 1, the spellfix line, and a Could not save with no rc -1 or 10 line do not qualify', () => {
		const rc1 = [{ rc: 1, kind: 'step' as const, statement: 'SELECT notes', line: 1 }];
		expect(occurrenceRecord(rc1, [lineAt(1, 'warning', 'sqlite3_step() rc= 1 SQLITE_ERROR SQL = SELECT 1 FROM notes')])[0]).toMatchObject({ qualifies: false });
		const spell = [{ rc: -1, kind: 'step' as const, statement: 'CREATE VIRTUAL TABLE notes_spellfix', line: 1 }];
		expect(occurrenceRecord(spell, [lineAt(1, 'warning', 'x')])[0]).toMatchObject({ qualifies: false });
		const save = records([lineAt(1, 'error', 'models/Setting: Could not save settings {type: error}')]);
		expect(save).toHaveLength(1);
		expect(save[0]).toMatchObject({ rc: null, qualifies: false });
		// with an rc -1 line, the save is part of the same occurrence (shape A): one record
		expect(records([lineAt(1, 'warning', 'sqlite3_step() rc= -1 undefined SQL = DELETE FROM settings WHERE key IN (?)'), lineAt(1, 'error', 'models/Setting: Could not save settings {}')])).toHaveLength(1);
	});
});
