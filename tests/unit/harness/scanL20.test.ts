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

	test('l20scan-03 equal content in two different tests counts twice, and a stack-logs copy of an output file counts once, named by its stem', () => {
		const record = withRecords([{ rc: -1, statement: 'SELECT folders', db: 'main', startupFailed: false, qualifies: true }]);
		const two = scanL20([file('r/output/t1-chromium/web-sqlite.json', record), file('r/output/t2-chromium/web-sqlite.json', record)]);
		expect(two.occurrences.map(o => o.test)).toEqual(['t1-chromium', 't2-chromium']);
		expect(two.qualifying).toBe(2);
		const copy = scanL20([file('r/output/t1-chromium/web-sqlite.json', record), file('r/stack/nst-e2e-abc-1a2b3c4d-web-sqlite.json', record)]);
		expect(copy.occurrences).toHaveLength(1);
		const lone = scanL20([file('r/stack/nst-e2e-abc-1a2b3c4d-web-sqlite.json', record)]);
		expect(lone.occurrences[0].test).toBe('nst-e2e-abc-1a2b3c4d (stack log)');
	});

	test('l20scan-04 a file that is not JSON is skipped and named, the others are still counted', () => {
		const good = file('r/output/t1-chromium/web-sqlite.json', withRecords([{ rc: 10, statement: 'COMMIT', db: 'main', startupFailed: true, qualifies: true }]));
		const r = scanL20([{ path: 'r/output/t0-chromium/web-sqlite.json', text: '{"failures": [' }, good]);
		expect(r.skipped).toEqual(['r/output/t0-chromium/web-sqlite.json']);
		expect(r.occurrences).toHaveLength(1);
	});

	test('l20scan-05 a runner given by the caller wins over the folder name, which stays the fallback', () => {
		const a = file('r/test-results-e2e-arm64/output/a-chromium/web-sqlite.json', withRecords([{ rc: -1, statement: 'SELECT notes', db: 'main', startupFailed: false, qualifies: true }]));
		expect(scanL20([a], { runner: 'ubuntu-24.04-arm' }).occurrences[0].runner).toBe('ubuntu-24.04-arm');
		expect(scanL20([a]).occurrences[0].runner).toBe('arm64');
		expect(scanL20([file('x/a/web-sqlite.json', withRecords([{ rc: -1, statement: 'SELECT notes', db: 'main', startupFailed: false, qualifies: true }]))]).occurrences[0].runner).toBe('local');
	});
});
