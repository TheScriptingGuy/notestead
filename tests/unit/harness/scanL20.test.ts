// The run-wide L20 count (tests/support/l20Scan.ts scanL20, tests/harness/tools/scan-l20.ts; L20 tie 2026-11-13): reads the
// web-sqlite.json files of a run and counts qualifying and non-qualifying SQLite failures, each file's content once.
import { describe, expect, test } from '@jest/globals';
import { scanL20 } from '../../support/l20Scan.ts';

const file = (path: string, json: object, consoleText?: string): { path: string; text: string; consoleText?: string } => ({ path, text: JSON.stringify(json), consoleText });

const withRecords = (records: object[]): object => ({ failures: [], args: [], storage: {}, records });
const legacy = (failures: object[]): object => ({ failures, args: [], storage: {} });

describe('L20 scan', () => {
	test('l20scan-01 counts qualifying and non-qualifying records over two files, with their fields', () => {
		const a = file('results/test-results-e2e-arm64/output/a-chromium/web-sqlite.json', withRecords([{ rc: -1, statement: 'SELECT folders', db: 'main', startupFailed: false, qualifies: true }]));
		const b = file('results/test-results-e2e-x64/output/b-chromium-retry1/web-sqlite.json', withRecords([{ rc: null, statement: 'settings', db: 'unknown', startupFailed: false, qualifies: false }, { rc: 10, statement: 'COMMIT', db: 'main', startupFailed: true, qualifies: true }]));
		const r = scanL20([a, b]);
		expect(r.qualifying).toBe(2);
		expect(r.nonQualifying).toBe(1);
		expect(r.occurrences).toHaveLength(3);
		expect(r.occurrences[0]).toMatchObject({ runner: 'arm64', test: 'a-chromium', attempt: 1, rc: -1, db: 'main', startupFailed: false, qualifies: true, path: a.path });
		expect(r.occurrences[1]).toMatchObject({ runner: 'x64', test: 'b-chromium-retry1', attempt: 2, qualifies: false });
	});

	test('l20scan-02 a duplicated copy counts once, and a file without records is derived from its failures and console', () => {
		const record = withRecords([{ rc: -1, statement: 'SELECT folders', db: 'main', startupFailed: false, qualifies: true }]);
		const r1 = scanL20([file('x/a/web-sqlite.json', record), file('x/a/attachments/web-sqlite-json-1.json', record)]);
		expect(r1.occurrences).toHaveLength(1);
		const failures = [{ rc: -1, kind: 'step', statement: 'COMMIT', line: 1 }, { rc: null, kind: 'startup', statement: 'buildStartupTasks/openDatabase', line: 2 }];
		const consoleText = '2026-11-13T10:00:01.000Z [warning] sqlite3_step() rc= -1 undefined SQL = COMMIT\n2026-11-13T10:00:02.000Z [error] root: Startup failure during task: buildStartupTasks/openDatabase';
		const r2 = scanL20([file('x/b/web-sqlite.json', legacy(failures), consoleText)]);
		expect(r2.occurrences).toHaveLength(1);
		expect(r2.occurrences[0]).toMatchObject({ rc: -1, db: 'main', startupFailed: true, qualifies: true });
		expect(r2.qualifying).toBe(1);
		expect(r2.nonQualifying).toBe(0);
	});
});
