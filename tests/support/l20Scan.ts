// The run-wide L20 count (L20 tie 2026-11-13; docs/test-plans/M2-S3.md §L20 tie, §Brief CC-L20): the pure core of
// tests/harness/tools/scan-l20.ts. It reads the `web-sqlite.json` files of a run (as text) and returns one row per occurrence.
// - A file written before the records existed is derived from its failures and, when given, its browser console.
// - De-duplication is per test (review M2-S3-r1 F1): a copy under attachments/ is the same event as its test's web-sqlite.json,
//   but equal content in two different tests counts twice. A copy in the stack logs dir (`<project>-<id>-web-sqlite.json`) is
//   only counted when no test directory holds the same content, and is named by its stem.
// - A file that is not valid JSON is skipped and listed in `skipped` (F5); it never stops the scan.
// - The runner is the caller's `opts.runner` (NOTESTEAD_RUNNER or --runner in the tool), else a `test-results-e2e-<runner>` path
//   segment, else `local` (F3).
// Value-free: rows hold kinds and paths.
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { occurrenceRecord } from '../e2e/support/webSqlite.ts';
import type { OccurrenceRecord, SqliteFailure } from '../e2e/support/webSqlite.ts';

export interface L20File { path: string; text: string; consoleText?: string }
export interface L20Occurrence extends OccurrenceRecord { runner: string; test: string; attempt: number; path: string }
export interface L20Scan { occurrences: L20Occurrence[]; qualifying: number; nonQualifying: number; skipped: string[] }

const runnerOf = (path: string): string => /test-results-e2e-([^/\\]+)/.exec(path)?.[1] ?? 'local';

const isStackCopy = (path: string): boolean => /-web-sqlite\.json$/.test(basename(path));

// The test's output directory name, which carries Playwright's `-retryN` suffix; a copy under attachments/ names its parent; a
// stack-logs copy is named by its file stem.
const testOf = (path: string): string => {
	if (isStackCopy(path)) return `${basename(path).replace(/-web-sqlite\.json$/, '')} (stack log)`;
	const dir = dirname(path);
	return basename(dir) === 'attachments' ? basename(dirname(dir)) : basename(dir);
};

export const scanL20 = (files: L20File[], opts: { runner?: string } = {}): L20Scan => {
	const skipped: string[] = [];
	const parsed = files.flatMap(f => {
		try {
			const json = JSON.parse(f.text) as { failures?: SqliteFailure[]; records?: OccurrenceRecord[] };
			// the content, not its formatting
			return [{ f, json, hash: createHash('sha256').update(JSON.stringify(json)).digest('hex') }];
		} catch {
			skipped.push(f.path);
			return [];
		}
	});
	const primary = parsed.filter(p => !isStackCopy(p.f.path));
	const primaryHashes = new Set(primary.map(p => p.hash));
	const seen = new Set<string>();
	const occurrences: L20Occurrence[] = [];
	for (const { f, json, hash } of [...primary, ...parsed.filter(p => isStackCopy(p.f.path) && !primaryHashes.has(p.hash))]) {
		const test = testOf(f.path);
		const key = `${test}\n${hash}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const records = json.records ?? occurrenceRecord(json.failures ?? [], f.consoleText ? f.consoleText.split('\n') : []);
		const retry = /-retry(\d+)$/.exec(test)?.[1];
		for (const r of records) occurrences.push({ runner: opts.runner ?? runnerOf(f.path), test, attempt: retry ? Number(retry) + 1 : 1, rc: r.rc, statement: r.statement, db: r.db, startupFailed: r.startupFailed, qualifies: r.qualifies, path: f.path });
	}
	const qualifying = occurrences.filter(o => o.qualifies).length;
	return { occurrences, qualifying, nonQualifying: occurrences.length - qualifying, skipped };
};
