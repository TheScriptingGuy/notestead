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
