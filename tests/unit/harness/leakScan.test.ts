// The file selection of the contract leak scans (tests/contract/support/leakScan.ts): review M1-S6a-r1 C1-R4 (a file under
// html/trace/ is skipped only while it is an unchanged copy of Playwright's trace viewer) and review M1-S8 C2 (leak
// assertions never print the leaked text). docs/test-plans/M2-S1.md.
import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { leakLines, scannedFiles } from '../../contract/support/leakScan.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';

const write = (path: string, data: string | Buffer): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
};

describe('leak scan file selection', () => {
	const dirs: string[] = [];
	const tmp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), 'nst-leakscan-'));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	test('c1-r4-unit-1 skips an unchanged trace-viewer copy and scans a changed or unknown file under html/trace/', () => {
		const out = tmp();
		const viewer = join(findRepoRoot(), 'node_modules', 'playwright-core', 'lib', 'vite', 'traceViewer');
		const files = readdirSync(viewer).filter(n => statSync(join(viewer, n)).isFile()).sort();
		expect(files.length).toBeGreaterThanOrEqual(2);
		const [name, name2] = files;
		write(join(out, 'html', 'trace', name), readFileSync(join(viewer, name)));
		write(join(out, 'html', 'trace', name2), Buffer.concat([readFileSync(join(viewer, name2)), Buffer.from('\n// nst-c1r4')]));
		write(join(out, 'html', 'trace', 'run-data.json'), '{}');
		write(join(out, 'html', 'data', 'x.zip'), 'zip');
		write(join(out, 'output', 'a.txt'), 'a');
		expect(scannedFiles(out).map(f => relative(out, f)).sort()).toEqual(['html/data/x.zip', `html/trace/${name2}`, 'html/trace/run-data.json', 'output/a.txt'].sort());
	});

	test('c1-r4-unit-2 scans every file when there is no html/trace/', () => {
		const out = tmp();
		write(join(out, 'output', 'a.txt'), 'a');
		write(join(out, 'junit.xml'), '<x/>');
		expect(scannedFiles(out).map(f => relative(out, f)).sort()).toEqual(['junit.xml', 'output/a.txt']);
	});

	test('c2-unit-1 leak lines name the place and kind, never the leaked text', () => {
		const result = leakLines([{ where: '/x/run/a.txt', kind: 'token=', excerpt: 'before nstmarker0123 after' }], '/x/run');
		expect(result).toEqual(['<run>/a.txt: token=']);
		expect(JSON.stringify(result)).not.toContain('nstmarker0123');
	});
});
