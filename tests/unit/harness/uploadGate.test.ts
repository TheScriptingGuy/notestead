// M1-S8 C1-R2 (review M1-S6a-r1 C1-R2, M1-S7-r1) and C5 (review M1-S6-r1): nothing unredacted is ever uploaded, even
// from a run killed before the redacting reporter finished. docs/test-plans/M1-S8.md §C1-R2.
// - The redacting reporter writes `redaction-pending.json` (listing the run's output dir and report paths) in onBegin
//   and `redaction-complete.json` once everything is redacted (onExit, after every reporter's onEnd).
// - The upload gate (tests/support/uploadGate.ts, CLI tests/harness/upload-gate.ts) removes the outputs of every run
//   whose redaction did not complete, removes planted.json and Playwright's raw `.playwright-artifacts-*` dirs,
//   redacts every remaining file with the leftover secret registries, removes those registries, and writes a
//   value-free summary. The killed-run proof on a real Playwright process is tests/integration/harness/c1r2-killed-run.
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import RedactingReporter from '../../e2e/support/redactingReporter.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { textViews } from '../../support/redact.ts';
import { secretsFileEnv } from '../../support/secrets.ts';
import { completeMarker, pendingMarker, runUploadGate } from '../../support/uploadGate.ts';
import { writeZip } from '../../support/zip.ts';

const secret = 'nstpw-c1r2-0123456789abcdef';

const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap(name => {
	const p = join(dir, name);
	return statSync(p).isDirectory() ? filesUnder(p) : [p];
}) : []);

const leaksUnder = (dir: string): string[] => filesUnder(dir).filter(f => textViews(f, readFileSync(f)).some(v => v.text.includes(secret))).map(f => relative(dir, f));

const write = (path: string, data: string | Buffer): string => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
	return path;
};

describe('M1-S8 C1-R2 and C5: what CI may upload', () => {
	describe('upload gate (C1-R2)', () => {
		let work: string;
		let saved: string | undefined;

		beforeEach(() => {
			work = mkdtempSync(join(tmpdir(), 'nst-unit-c1r2-'));
			saved = process.env[secretsFileEnv];
			delete process.env[secretsFileEnv];
		});

		afterEach(() => {
			rmSync(work, { recursive: true, force: true });
			if (saved === undefined) delete process.env[secretsFileEnv];
			else process.env[secretsFileEnv] = saved;
		});

		// test-results/ with a finished run (e2e), a run killed before its redaction (a contract self-test), a stack log,
		// planted.json and a raw trace dir; playwright-report/ of the finished run; a leftover registry in a temp dir.
		const plant = (): { results: string; report: string; secrets: string; registry: string } => {
			const results = join(work, 'test-results');
			const report = join(work, 'playwright-report');
			const e2e = join(results, 'e2e');
			write(join(e2e, pendingMarker), JSON.stringify({ paths: [join(e2e, 'output'), report, join(e2e, 'junit.xml')] }));
			write(join(e2e, completeMarker), JSON.stringify({ complete: true }));
			write(join(e2e, 'output', 't1', 'trace.zip'), writeZip([{ name: 'trace.network', data: Buffer.from('{"clean":true}\n') }]));
			write(join(e2e, 'junit.xml'), '<testsuites tests="1"/>');
			write(join(report, 'index.html'), '<html>clean report</html>');
			write(join(e2e, 'output', '.playwright-artifacts-0', 'trace.network'), `{"body":"${secret}"}\n`);
			const killed = join(results, 'contract', 'm1-s7', 'c1r1');
			write(join(killed, pendingMarker), JSON.stringify({ paths: [join(killed, 'output'), join(killed, 'html'), join(killed, 'junit.xml')] }));
			write(join(killed, 'output', 't', 'trace.zip'), writeZip([{ name: 'resources/login.json', data: Buffer.from(`{"password":"${secret}"}`) }]));
			write(join(killed, 'html', 'data', 'abc.zip'), writeZip([{ name: 'trace.trace', data: Buffer.from(`fill ${secret}`) }]));
			write(join(killed, 'junit.xml'), `<failure>${secret}</failure>`);
			write(join(killed, 'stack', 'web.log'), `typed ${secret} into a field\n`);
			write(join(results, 'contract', 'm1-s6', 'ac20', 'planted.json'), JSON.stringify({ secrets: [{ label: 'x', value: secret }] }));
			const secrets = join(work, 'tmp');
			const registry = write(join(secrets, 'nst-secrets-AbC123', 'secrets.jsonl'), `${JSON.stringify({ label: 'leftover_password', value: secret })}\n`);
			return { results, report, secrets, registry };
		};

		test('c1r2-gate-neg control: the planted tree carries the secret in every channel the gate must handle', () => {
			const p = plant();
			expect(leaksUnder(work).sort()).toEqual([
				'test-results/contract/m1-s6/ac20/planted.json',
				'test-results/contract/m1-s7/c1r1/html/data/abc.zip',
				'test-results/contract/m1-s7/c1r1/junit.xml',
				'test-results/contract/m1-s7/c1r1/output/t/trace.zip',
				'test-results/contract/m1-s7/c1r1/stack/web.log',
				'test-results/e2e/output/.playwright-artifacts-0/trace.network',
				relative(work, p.registry),
			].sort());
		});

		test('c1r2-gate after the gate no file under the roots holds the secret; an incomplete run loses its outputs; a complete run keeps them', () => {
			const p = plant();
			const summary = runUploadGate({ roots: [p.results, p.report], secretsDirs: [p.secrets] });
			expect({ results: leaksUnder(p.results), report: leaksUnder(p.report) }).toEqual({ results: [], report: [] });
			expect({
				keptTrace: existsSync(join(p.results, 'e2e', 'output', 't1', 'trace.zip')),
				keptReport: existsSync(join(p.report, 'index.html')),
				keptJunit: existsSync(join(p.results, 'e2e', 'junit.xml')),
				killedOutput: existsSync(join(p.results, 'contract', 'm1-s7', 'c1r1', 'output')),
				killedHtml: existsSync(join(p.results, 'contract', 'm1-s7', 'c1r1', 'html')),
				killedJunit: existsSync(join(p.results, 'contract', 'm1-s7', 'c1r1', 'junit.xml')),
				stackLogKept: existsSync(join(p.results, 'contract', 'm1-s7', 'c1r1', 'stack', 'web.log')),
				planted: existsSync(join(p.results, 'contract', 'm1-s6', 'ac20', 'planted.json')),
				rawTraceDir: existsSync(join(p.results, 'e2e', 'output', '.playwright-artifacts-0')),
				registry: existsSync(p.registry),
			}).toEqual({
				keptTrace: true, keptReport: true, keptJunit: true,
				killedOutput: false, killedHtml: false, killedJunit: false, stackLogKept: true,
				planted: false, rawTraceDir: false, registry: false,
			});
			expect(readFileSync(join(p.results, 'contract', 'm1-s7', 'c1r1', 'stack', 'web.log'), 'utf8')).toContain('[leftover_password]');
			const runs = Object.fromEntries(summary.runs.map(r => [relative(work, join(process.cwd(), r.dir)) || r.dir, r.complete]));
			expect(Object.values(runs).sort()).toEqual([false, true]);
			expect({ planted: summary.plantedRemoved, rawDirs: summary.artifactDirsRemoved, registries: summary.registries }).toEqual({ planted: 1, rawDirs: 1, registries: 1 });
		});

		test('c1r2-gate-summary the summary file is written under the first root and holds no secret; a second run is a no-op', () => {
			const p = plant();
			runUploadGate({ roots: [p.results, p.report], secretsDirs: [p.secrets] });
			const summaryFile = join(p.results, 'upload-gate.json');
			expect(existsSync(summaryFile)).toBe(true);
			expect(readFileSync(summaryFile, 'utf8')).not.toContain(secret);
			const again = runUploadGate({ roots: [p.results, p.report], secretsDirs: [p.secrets] });
			expect({ removed: again.filesRemoved, planted: again.plantedRemoved, leaks: leaksUnder(work) }).toEqual({ removed: 0, planted: 0, leaks: [] });
		});

		// Finding F1 (docs/test-plans/M1-S8.md): a file is rewritten and counted only when redaction changed a value, not
		// when the JSON was merely re-serialised (Jest's pretty-printed results, Playwright's report.json).
		test('f1-gate-count formatting-only differences are neither rewritten nor counted; a replaced secret is (positive control)', () => {
			const results = join(work, 'test-results');
			const pretty = write(join(results, 'contract', 'jest-results.json'), `${JSON.stringify({ success: true, numTotalTests: 2, testResults: [{ name: 'a' }] }, null, 2)}\n`);
			const zipped = write(join(results, 'e2e', 'output', 't', 'clean.zip'), writeZip([{ name: 'report.json', data: Buffer.from(JSON.stringify({ ok: true }, null, 2)) }, { name: 'trace.network', data: Buffer.from('{ "a" : 1 }\n{"b":2}\n') }]));
			const before = { pretty: readFileSync(pretty), zipped: readFileSync(zipped) };
			const leaky = write(join(results, 'contract', 'stack', 'web.log'), `typed ${secret}\n`);
			const secrets = join(work, 'tmp');
			write(join(secrets, 'nst-secrets-F1f1f1', 'secrets.jsonl'), `${JSON.stringify({ label: 'leftover_password', value: secret })}\n`);
			const summary = runUploadGate({ roots: [results], secretsDirs: [secrets] });
			expect({
				counted: summary.filesRedacted,
				prettyUntouched: readFileSync(pretty).equals(before.pretty),
				zipUntouched: readFileSync(zipped).equals(before.zipped),
				leakyRedacted: readFileSync(leaky, 'utf8').includes('[leftover_password]'),
			}).toEqual({ counted: 1, prettyUntouched: true, zipUntouched: true, leakyRedacted: true });
			// The summary names what it rewrote (paths only), so a CI run's evidence shows where redaction happened.
			expect(summary.redacted.map(p => relative(work, join(process.cwd(), p)))).toEqual(['test-results/contract/stack/web.log']);
		});

		// Findings F2 and F3 (docs/test-plans/M1-S8.md VERIFY): Playwright's trace viewer, copied verbatim into every HTML
		// report (html/trace/), contains `cookie=` in its code, which the header pattern used to rewrite, breaking the
		// viewer in uploaded reports; and a value that is already redacted (Caddy writes "X-Api-Auth":["REDACTED"]) was
		// rewritten and counted. A changed copy of a viewer file is still redacted (review M1-S6a-r1 C1-R4).
		test('f2-f3-gate the packaged trace viewer and already-redacted values are left alone; a modified viewer file is still redacted', () => {
			const viewerDir = join(findRepoRoot(), 'node_modules', 'playwright-core', 'lib', 'vite', 'traceViewer', 'assets');
			const name = readdirSync(viewerDir).find(f => f.endsWith('.js') && readFileSync(join(viewerDir, f), 'utf8').includes('cookie='));
			expect(name).toBeDefined();
			const original = readFileSync(join(viewerDir, name ?? ''));
			const results = join(work, 'test-results');
			const viewer = write(join(results, 'contract', 'run', 'html', 'trace', 'assets', name ?? 'x.js'), original);
			const tampered = write(join(results, 'contract', 'run', 'html', 'trace', 'assets', 'tampered.js'), `${original.toString('utf8')}\n// ${secret}\n`);
			const caddyLine = `${JSON.stringify({ request: { headers: { 'X-Api-Auth': ['REDACTED'], 'Accept': ['*/*'] } } })}\n`;
			const caddy = write(join(results, 'contract', 'run', 'stack', 'web.log'), caddyLine);
			const secrets = join(work, 'tmp');
			write(join(secrets, 'nst-secrets-F2f2f2', 'secrets.jsonl'), `${JSON.stringify({ label: 'leftover_password', value: secret })}\n`);
			const summary = runUploadGate({ roots: [results], secretsDirs: [secrets] });
			expect({
				viewerUntouched: readFileSync(viewer).equals(original),
				caddyUntouched: readFileSync(caddy, 'utf8') === caddyLine,
				tamperedRedacted: !readFileSync(tampered, 'utf8').includes(secret),
				counted: summary.filesRedacted,
			}).toEqual({ viewerUntouched: true, caddyUntouched: true, tamperedRedacted: true, counted: 1 });
		});

		test('c1r2-gate-missing roots that do not exist are fine (a job that failed before its tests ran)', () => {
			const summary = runUploadGate({ roots: [join(work, 'nope'), join(work, 'nope2')], secretsDirs: [join(work, 'tmp')], summaryFile: join(work, 'summary.json') });
			expect(summary.runs).toEqual([]);
		});
	});

	describe('redacting reporter marks when its redaction is complete (C1-R2)', () => {
		let work: string;

		beforeEach(() => {
			work = mkdtempSync(join(tmpdir(), 'nst-unit-c1r2-marker-'));
		});

		afterEach(() => {
			rmSync(work, { recursive: true, force: true });
		});

		const config = (): FullConfig => ({
			configFile: join(work, 'playwright.config.ts'),
			rootDir: work,
			projects: [{ outputDir: join(work, 'test-results', 'e2e', 'output') }],
			reporter: [
				['./tests/e2e/support/redactingReporter.ts', {}],
				['html', { outputFolder: 'playwright-report', open: 'never' }],
				['junit', { outputFile: 'test-results/e2e/junit.xml' }],
			],
		} as unknown as FullConfig);

		test('c1r2-marker-pending onBegin removes a stale complete marker and writes a pending marker listing the run\'s output dir and report paths', () => {
			const e2e = join(work, 'test-results', 'e2e');
			write(join(e2e, completeMarker), '{"complete":true}');
			const reporter = new RedactingReporter();
			reporter.onBegin(config());
			const pending = existsSync(join(e2e, pendingMarker)) ? JSON.parse(readFileSync(join(e2e, pendingMarker), 'utf8')) as { paths?: string[] } : undefined;
			expect({ stale: existsSync(join(e2e, completeMarker)), paths: [...(pending?.paths ?? [])].sort() }).toEqual({
				stale: false,
				paths: [join(e2e, 'output'), join(e2e, 'junit.xml'), join(work, 'playwright-report')].sort(),
			});
		});

		test('c1r2-marker-complete the complete marker appears only after onEnd and onExit, not after the last test', async () => {
			const e2e = join(work, 'test-results', 'e2e');
			const reporter = new RedactingReporter();
			reporter.onBegin(config());
			reporter.onTestEnd({} as TestCase, { errors: [], stdout: [], stderr: [], steps: [], attachments: [] } as unknown as TestResult);
			const afterTest = existsSync(join(e2e, completeMarker));
			reporter.onEnd();
			await reporter.onExit();
			expect({ afterTest, afterExit: existsSync(join(e2e, completeMarker)) }).toEqual({ afterTest: false, afterExit: true });
		});
	});

	describe('planted.json never lands under test-results/ (C5)', () => {
		test('c5-planted every harness self-test spec takes its planted file from NST_SELFTEST_PLANTED (a 0600 file outside test-results/)', () => {
			const dir = join(findRepoRoot(), 'tests', 'harness', 'selftest');
			const offenders = readdirSync(dir).filter(f => f.endsWith('.spec.ts')).filter(f => {
				const text = readFileSync(join(dir, f), 'utf8');
				return text.includes('planted') && (/'planted\.json'/.test(text) || !text.includes('NST_SELFTEST_PLANTED'));
			});
			expect(offenders).toEqual([]);
		});
	});
});

