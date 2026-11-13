// Recognises a real browser SQLite failure in a test's console lines (WEB-SQLITE-1, docs/test-plans/M2-S3.md R1/WS-1). No
// Playwright import: unit-tested in tests/unit/harness/webSqlite.test.ts. A result names the kind, the result code and the
// statement's verb and table; it never carries the SQL or a bound value, which can hold note content (review M2-S2-r1 C4).
export type SqliteFailureKind = 'step' | 'save' | 'startup';
export interface SqliteFailure { rc: number | null; kind: SqliteFailureKind; statement: string; line: number }

// "sqlite3_step() rc= <n> <NAME> SQL = <sql>", logged as a warning by the sqlite-wasm worker driver. rc 0 and 1 are not
// failures: rc 1 is the startup `CREATE VIRTUAL TABLE notes_spellfix USING spellfix1` line, and the ROLLBACK after a failure.
const stepPattern = /sqlite3_step\(\) rc= (-?\d+)\b[^\n]*?SQL = ([\s\S]*)/;
const savePattern = /Could not save\s+([A-Za-z_]+)/;
const startupPattern = /Startup failure during task: buildStartupTasks\/openDatabase/;
const ignoredRcs = new Set([0, 1]);

// The statement's verb and table only: "DELETE FROM settings WHERE …" is "DELETE settings".
export const statementName = (sql: string): string => {
	const s = sql.trim().replace(/\s+/g, ' ');
	const name = '[`"\\[]?([A-Za-z_][A-Za-z0-9_]*)';
	const patterns: [RegExp, (m: RegExpExecArray) => string][] = [
		[new RegExp(`^(CREATE|DROP)(?: UNIQUE)?(?: VIRTUAL)? (TABLE|INDEX|TRIGGER|VIEW)(?: IF (?:NOT )?EXISTS)? ${name}`, 'i'), m => `${m[1].toUpperCase()}${/virtual/i.test(m[0]) ? ' VIRTUAL' : ''} ${m[2].toUpperCase()} ${m[3]}`],
		[new RegExp(`^ALTER TABLE ${name}`, 'i'), m => `ALTER TABLE ${m[1]}`],
		[new RegExp(`^(?:INSERT|REPLACE)(?: OR \\w+)? INTO ${name}`, 'i'), m => `${/^replace/i.test(m[0]) ? 'REPLACE' : 'INSERT'} ${m[1]}`],
		[new RegExp(`^DELETE FROM ${name}`, 'i'), m => `DELETE ${m[1]}`],
		[new RegExp(`^UPDATE(?: OR \\w+)? ${name}`, 'i'), m => `UPDATE ${m[1]}`],
		[new RegExp(`^SELECT .*? FROM ${name}`, 'i'), m => `SELECT ${m[1]}`],
		[/^PRAGMA ([A-Za-z_]+)/i, m => `PRAGMA ${m[1]}`],
	];
	for (const [pattern, name2] of patterns) {
		const m = pattern.exec(s);
		if (m) return name2(m);
	}
	return /^[A-Za-z]+/.exec(s)?.[0].toUpperCase() ?? 'unknown';
};

export const sqliteFailures = (lines: string[]): SqliteFailure[] => {
	const found: SqliteFailure[] = [];
	lines.forEach((text, index) => {
		const line = index + 1;
		const level = /^\S+ \[(\w+)\]/.exec(text)?.[1];
		const step = stepPattern.exec(text);
		if (step && (level === 'warning' || level === 'error')) {
			const rc = Number(step[1]);
			if (!ignoredRcs.has(rc)) found.push({ rc, kind: 'step', statement: statementName(step[2]), line });
			return;
		}
		if (level !== 'error') return;
		const save = savePattern.exec(text);
		if (save) found.push({ rc: null, kind: 'save', statement: save[1], line });
		else if (startupPattern.test(text)) found.push({ rc: null, kind: 'startup', statement: 'buildStartupTasks/openDatabase', line });
	});
	return found;
};

export const sqliteFailureLines = (failures: SqliteFailure[]): string[] =>
	failures.map(f => `SQLite ${f.kind}: rc ${f.rc}, ${f.statement} (console line ${f.line})`);

// Which page reads navigator.storage.estimate(): the app's own page when it is on the web origin, else a fresh same-origin
// probe (an about:blank or data: page has an opaque origin, where the estimate fails; WS-5a).
export const estimatePageChoice = (appPageUrl: string | undefined, webOrigin: string): 'app' | 'probe' => {
	try {
		return appPageUrl !== undefined && new URL(appPageUrl).origin === new URL(webOrigin).origin ? 'app' : 'probe';
	} catch {
		return 'probe';
	}
};

// An L20 occurrence record (L20 tie 2026-11-13; docs/test-plans/M2-S3.md §L20 tie): what a run's SQLite failures say about the
// database they ran on, whether startup failed, and whether they qualify for the tie (only rc -1 or 10, never the spellfix line,
// never a lone "Could not save"). `db` is never guessed: a bare BEGIN/COMMIT/ROLLBACK with no startup failure within 2 s is
// 'unknown'. Value-free like the failures it comes from.
export interface OccurrenceRecord { rc: number | null; statement: string; db: 'main' | 'log' | 'unknown'; startupFailed: boolean; qualifies: boolean }

const startupTaskPattern = /Startup failure during task: buildStartupTasks\/(\S+)/;
const qualifyingRcs = new Set([-1, 10]);
const bareTransaction = /^(BEGIN|COMMIT|ROLLBACK)\b/;

const dbOfTask = (task: string): 'main' | 'log' => (/log/i.test(task) ? 'log' : 'main');

export const occurrenceRecord = (failures: SqliteFailure[], consoleLines: string[]): OccurrenceRecord[] => {
	const stamped = consoleLines.map((text, index) => ({ index, time: Date.parse(text.split(' ')[0]), task: startupTaskPattern.exec(text)?.[1] }));
	const startups = stamped.filter(l => l.task !== undefined);
	const startupFailed = startups.length > 0 || failures.some(f => f.kind === 'startup');
	const records: OccurrenceRecord[] = [];
	for (const f of failures.filter(x => x.kind === 'step')) {
		const qualifies = f.rc !== null && qualifyingRcs.has(f.rc) && !/spellfix/i.test(f.statement);
		let db: OccurrenceRecord['db'] = 'main';
		if (/\blogs$/.test(f.statement)) {
			db = 'log';
		} else if (bareTransaction.test(f.statement)) {
			db = 'unknown';
			const own = stamped[f.line - 1];
			const near = startups.find(s => (Number.isNaN(own?.time ?? Number.NaN) || Number.isNaN(s.time))
				? Math.abs(s.index - (f.line - 1)) <= 3
				: s.time - own.time >= 0 && s.time - own.time <= 2_000)
				?? failures.filter(x => x.kind === 'startup').map(x => ({ task: x.statement, index: x.line - 1, time: Number.NaN })).find(s => Number.isNaN(own?.time ?? Number.NaN) && Math.abs(s.index - (f.line - 1)) <= 3);
			if (near?.task !== undefined) db = dbOfTask(near.task);
		}
		records.push({ rc: f.rc, statement: f.statement, db, startupFailed, qualifies });
	}
	if (records.length === 0) {
		for (const f of failures.filter(x => x.kind === 'save')) records.push({ rc: null, statement: f.statement, db: 'unknown', startupFailed, qualifies: false });
	}
	if (records.length === 0 && startupFailed) records.push({ rc: null, statement: 'buildStartupTasks', db: 'unknown', startupFailed, qualifies: false });
	return records;
};
