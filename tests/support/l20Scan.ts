// The run-wide L20 count (L20 tie 2026-11-13; docs/test-plans/M2-S3.md §L20 tie, §Brief CC-L20): the pure core of
// tests/harness/tools/scan-l20.ts. It reads the `web-sqlite.json` files of a run (as text) and returns one row per occurrence,
// each file's content counted once (a copy under attachments/ or in the stack logs dir is the same event). A file written before
// the records existed is derived from its failures and, when given, its browser console. Value-free: rows hold kinds and paths.
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { occurrenceRecord } from '../e2e/support/webSqlite.ts';
import type { OccurrenceRecord, SqliteFailure } from '../e2e/support/webSqlite.ts';

export interface L20File { path: string; text: string; consoleText?: string }
export interface L20Occurrence extends OccurrenceRecord { runner: string; test: string; attempt: number; path: string }
export interface L20Scan { occurrences: L20Occurrence[]; qualifying: number; nonQualifying: number }

const runnerOf = (path: string): string => /test-results-e2e-([^/\\]+)/.exec(path)?.[1] ?? 'local';

// The test's output directory name, which carries Playwright's `-retryN` suffix; a copy under attachments/ names its parent.
const testOf = (path: string): string => {
	const dir = dirname(path);
	return basename(dir) === 'attachments' ? basename(dirname(dir)) : basename(dir);
};

export const scanL20 = (files: L20File[]): L20Scan => {
	const seen = new Set<string>();
	const occurrences: L20Occurrence[] = [];
	for (const f of files) {
		const json = JSON.parse(f.text) as { failures?: SqliteFailure[]; records?: OccurrenceRecord[] };
		// the content, not its formatting: a copy written by another run of the harness is the same event
		const hash = createHash('sha256').update(JSON.stringify(json)).digest('hex');
		if (seen.has(hash)) continue;
		seen.add(hash);
		const records = json.records ?? occurrenceRecord(json.failures ?? [], f.consoleText ? f.consoleText.split('\n') : []);
		const test = testOf(f.path);
		const retry = /-retry(\d+)$/.exec(test)?.[1];
		for (const r of records) occurrences.push({ runner: runnerOf(f.path), test, attempt: retry ? Number(retry) + 1 : 1, rc: r.rc, statement: r.statement, db: r.db, startupFailed: r.startupFailed, qualifies: r.qualifies, path: f.path });
	}
	const qualifying = occurrences.filter(o => o.qualifies).length;
	return { occurrences, qualifying, nonQualifying: occurrences.length - qualifying };
};
