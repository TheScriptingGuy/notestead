// M1-S6a C1 (review M1-S6-r1 C1; ADR-0007, ADR-0008; M1-AC20 extended to per-test secrets): the secrets a test's own
// fixtures create (the per-test account's password and E2EE master password, the per-test headless service's Data API
// token) never reach an artifact or the console unredacted: not the Playwright trace, not stdout/stderr, not error
// messages, not step titles, not attachments (body or file), not the JSON, JUnit and HTML reports, not the run's
// console. The inner test tests/harness/selftest/pertest-secrets.spec.ts plants them into each channel and fails on
// purpose. Negative control (c1-neg): the same inner run with the per-test secret feed switched off (NST_SELFTEST_SECRET_FEED=off,
// honoured only by self-test runs) must show leaks in every channel, so the scan below can fail and each channel really
// carries the planted secret. The NEG run's artifacts are deleted after the scan; only a value-free summary is kept.
// docs/test-plans/M1-S6a.md.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnownSecret } from '../../support/redact.ts';
import { snapshot } from '../../stack/stack.ts';
import { channelViews, fileViews, harnessPassword, leakLines, leaksIn } from '../support/leakScan.ts';
import type { JsonResult, View } from '../support/leakScan.ts';
import { allSpecs, describeRun, runSelftest, stackImagesEnv } from '../support/selftest.ts';
import type { SelftestRun } from '../support/selftest.ts';
import { repoRoot } from '../support/podman.ts';

const minute = 60_000;
const resultsRoot = join(repoRoot, 'test-results', 'contract', 'm1-s6a');

interface Inner {
	run: SelftestRun;
	result?: JsonResult;
	secrets: KnownSecret[];
	leftovers: string[];
}

// The text a person or a CI artifact would see, per channel (tests/contract/support/leakScan.ts).
const channels = (inner: Inner): Record<string, View[]> => channelViews(inner.run, inner.result);

// Every file the run wrote plus the decoded bodies and buffers the JSON report holds in base64.
const everything = (inner: Inner): View[] => [...fileViews(inner.run), ...Object.values(channels(inner)).flat()];

const runInner = (label: string, env: Record<string, string>): Inner => {
	const plantedDir = mkdtempSync(join(tmpdir(), 'nst-c1-planted-'));
	const planted = join(plantedDir, 'planted.json');
	const before = snapshot();
	const run = runSelftest(label, 'selftest/pertest-secrets.spec.ts', { ...stackImagesEnv(), NST_SELFTEST_PLANTED: planted, ...env }, 25 * minute, resultsRoot);
	const after = snapshot();
	const leftovers = (['containers', 'networks', 'volumes', 'pods'] as const).flatMap(k => after[k].filter(n => !before[k].includes(n)).map(n => `${k}: ${n}`));
	const result = allSpecs(run.report?.suites ?? [])[0]?.tests[0]?.results[0] as unknown as JsonResult | undefined;
	const secrets = existsSync(planted) ? (JSON.parse(readFileSync(planted, 'utf8')) as { secrets: KnownSecret[] }).secrets.filter(s => s.value !== '') : [];
	rmSync(plantedDir, { recursive: true, force: true });
	return { run, result, secrets, leftovers };
};

describe('M1-S6a C1 per-test secrets are redacted in every channel', () => {
	let pos: Inner | undefined;
	let neg: Inner | undefined;

	beforeAll(() => {
		pos = runInner('c1', {});
		neg = runInner('c1-neg', { NST_SELFTEST_SECRET_FEED: 'off' });
	}, 60 * minute);

	afterAll(() => {
		// The NEG run leaks on purpose: keep only a value-free summary of what the scan found, never the artifacts.
		if (neg) {
			const summary = Object.fromEntries(Object.entries(channels(neg)).map(([name, views]) => [name, leaksIn(views, neg?.secrets ?? []).map(l => ({ where: l.where, kind: l.kind }))]));
			rmSync(neg.run.out, { recursive: true, force: true });
			writeFileSync(join(resultsRoot, 'c1-neg-summary.json'), `${JSON.stringify({ exit: neg.run.code, durationMs: neg.run.durationMs, leaks: summary }, null, 2)}\n`);
		}
	});

	const positive = (): Inner => {
		if (!pos) throw new Error('the inner run did not happen (see beforeAll)');
		return pos;
	};

	test('c1-ran the inner test failed on purpose (and only on purpose), planted three secrets, left nothing behind', () => {
		const p = positive();
		expect({ code: p.run.code === 0 ? 0 : 'non-zero', status: p.result?.status }).toEqual({ code: 'non-zero', status: 'failed' });
		const messages = (p.result?.errors ?? []).map(e => e.message ?? '').join('\n');
		expect(messages).toContain('C1: this failure is deliberate');
		expect(messages).toContain('C1: this soft failure is deliberate');
		expect(p.secrets.map(s => s.label).sort()).toEqual(['pertest_account_password', 'pertest_data_api_token', 'pertest_master_password']);
		expect(p.leftovers).toEqual([]);
	});

	test('c1-planted every channel carries the planting context (positive control: the scan below is not vacuous)', () => {
		const p = positive();
		const ch = channels(p);
		const has = (views: View[], needle: string | RegExp): boolean => views.some(v => (typeof needle === 'string' ? v.text.includes(needle) : needle.test(v.text)));
		const traceLines = ch.trace.filter(v => v.where.endsWith('.trace')).flatMap(v => v.text.split('\n'));
		expect({
			traceFill: traceLines.some(l => l.includes('"method":"fill"') && l.includes('Account password')),
			traceType: traceLines.some(l => l.includes('"method":"type"') && l.includes('Master password')),
			traceConsole: has(ch.trace, 'C1 planted data api token'),
			stdoutPassword: has(ch.stdout, 'C1 planted account password'),
			stdoutToken: has(ch.stdout, 'C1 planted data api token'),
			stderrMaster: has(ch.stdout, 'C1 planted master password'),
			stepTitle: has(ch.steps, 'C1 planted step'),
			junit: has(ch.reports.filter(v => v.where === 'junit.xml'), 'C1 planted account password'),
			htmlSteps: has(ch.reports.filter(v => v.where.startsWith('html report')), 'C1 planted step'),
			htmlFill: has(ch.reports.filter(v => v.where.startsWith('html report')), /"title":"Fill \\"/),
			consoleLive: has(ch.console, 'C1 planted account password'),
			errors: has(ch.errors, 'C1 planted master password') && has(ch.errors, 'C1 planted data api token'),
			bodyAttachment: has(ch.attachments.filter(v => v.where.includes('pertest-body.txt')), 'C1 planted account password'),
			fileAttachment: has(ch.attachments.filter(v => v.where.includes('pertest-file.txt')), 'C1 planted master password'),
			browserConsole: has(ch.attachments.filter(v => v.where.includes('browser-console.log')), 'C1 planted data api token'),
		}).toEqual({
			traceFill: true, traceType: true, traceConsole: true, stdoutPassword: true, stdoutToken: true, stderrMaster: true,
			stepTitle: true, junit: true, htmlSteps: true, htmlFill: true, consoleLive: true, errors: true, bodyAttachment: true,
			fileAttachment: true, browserConsole: true,
		});
	});

	for (const channel of ['trace', 'stdout', 'errors', 'steps', 'attachments', 'reports', 'console'] as const) {
		test(`c1-redacted-${channel} no per-test secret in the ${channel}`, () => {
			const p = positive();
			expect(p.secrets).toHaveLength(3);
			expect(leakLines(leaksIn(channels(p)[channel], p.secrets))).toEqual([]);
		});
	}

	test('c1-redacted-all no file the run wrote, and no report entry, holds a per-test secret or any harness password', () => {
		const p = positive();
		const views = everything(p);
		expect(views.length).toBeGreaterThan(10);
		expect(leakLines(leaksIn(views, p.secrets, [harnessPassword]))).toEqual([]);
	});

	test('c1-neg with the per-test secret feed off, the scan finds the planted secrets in every channel', () => {
		if (!neg) throw new Error('the NEG run did not happen (see beforeAll)');
		const n = neg;
		expect(n.run.code).not.toBe(0);
		expect(n.secrets).toHaveLength(3);
		const ch = channels(n);
		const found = Object.fromEntries((['trace', 'stdout', 'errors', 'steps', 'attachments', 'reports', 'console'] as const).map(c => [c, leaksIn(ch[c], n.secrets).length > 0]));
		expect({ found, attachments: n.result?.attachments.map(a => a.name) ?? describeRun(n.run) }).toEqual({
			found: { trace: true, stdout: true, errors: true, steps: true, attachments: true, reports: true, console: true },
			attachments: expect.arrayContaining(['trace', 'pertest-body.txt', 'pertest-file.txt']),
		});
	});
});
