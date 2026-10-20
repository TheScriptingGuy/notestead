// M1-S7 C1-R1 (review M1-S6a-r1 C1-R1; ADR-0007, ADR-0008; docs/test-plans/M1-S7.md): the leak scan of M1-S6a C1,
// applied to the walking skeleton's REAL login and E2EE-unlock flow in the real upstream web app. The inner test
// (tests/harness/selftest/realflow-secrets.spec.ts) types the per-test account password and master password like a
// user (password fields only), lets the app log in through the proxy (POST /api/sessions: the password in the request
// body, the session id in the response body and in every later X-API-AUTH header), unlocks E2EE, shows the sync
// settings with the password in its field, and fails on purpose, so Playwright keeps the trace and writes
// error-context.md. The scan covers the trace entry by entry (actions, DOM snapshots, `.network`, `resources/`: the
// request and response bodies), every attachment, the JSON, JUnit and HTML reports, the console, and every file the
// run wrote. Secrets: both passwords and every session id the browser sent.
// Negative control (c1r1-neg): the same run with the secret feed off (NST_SELFTEST_SECRET_FEED=off, self-test runs
// only) must show the planted values in the trace's network bodies, its actions and snapshots, error-context.md and
// the HTML report, so the clean scan cannot be vacuous. Its artifacts are deleted; only a value-free summary is kept.
// Needs the real bundle: NOTESTEAD_WEB_ARTIFACT=<CI web-bundle artifact dir> for the contract run.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnownSecret } from '../../support/redact.ts';
import { snapshot } from '../../stack/stack.ts';
import { channelViews, fileViews, harnessPassword, leakLines, leaksIn } from '../support/leakScan.ts';
import type { JsonResult, View } from '../support/leakScan.ts';
import { repoRoot, webImageInfo } from '../support/podman.ts';
import { allSpecs, describeRun, runSelftest, stackImagesEnv } from '../support/selftest.ts';
import type { SelftestRun } from '../support/selftest.ts';

const minute = 60_000;
const resultsRoot = join(repoRoot, 'test-results', 'contract', 'm1-s7');

interface Inner {
	run: SelftestRun;
	result?: JsonResult;
	reached: string;
	secrets: KnownSecret[];
	leftovers: string[];
}

// The channels C1-R1 names, as text views.
const views = (inner: Inner): Record<string, View[]> => {
	const ch = channelViews(inner.run, inner.result);
	const files = fileViews(inner.run);
	return {
		'trace-actions': ch.trace.filter(v => /\.trace$/.test(v.where) && !v.where.endsWith('.network')),
		'trace-network': ch.trace.filter(v => v.where.endsWith('.network') || v.where.includes('!resources/')),
		'error-context': [...ch.attachments.filter(v => v.where.includes('error-context')), ...files.filter(v => v.where.endsWith('error-context.md'))],
		'html-report': ch.reports.filter(v => v.where.startsWith('html report')),
		'junit-report': ch.reports.filter(v => v.where === 'junit.xml'),
		'json-report': [...ch.errors, ...ch.steps, ...ch.stdout, ...ch.attachments],
		'console': ch.console,
		'output-files': files,
	};
};

const runInner = (label: string, env: Record<string, string>): Inner => {
	const plantedDir = mkdtempSync(join(tmpdir(), 'nst-c1r1-planted-'));
	const planted = join(plantedDir, 'planted.json');
	const before = snapshot();
	const run = runSelftest(label, 'selftest/realflow-secrets.spec.ts', { ...stackImagesEnv(), NST_SELFTEST_PLANTED: planted, ...env }, 30 * minute, resultsRoot);
	const after = snapshot();
	const leftovers = (['containers', 'networks', 'volumes', 'pods'] as const).flatMap(k => after[k].filter(n => !before[k].includes(n)).map(n => `${k}: ${n}`));
	const result = allSpecs(run.report?.suites ?? [])[0]?.tests[0]?.results[0] as unknown as JsonResult | undefined;
	const plantedJson = existsSync(planted) ? JSON.parse(readFileSync(planted, 'utf8')) as { reached: string; secrets: KnownSecret[] } : { reached: 'none', secrets: [] };
	rmSync(plantedDir, { recursive: true, force: true });
	return { run, result, reached: plantedJson.reached, secrets: plantedJson.secrets.filter(s => s.value !== ''), leftovers };
};

describe('M1-S7 C1-R1 the real login and unlock flow leaves no secret in any artifact', () => {
	let pos: Inner | undefined;
	let neg: Inner | undefined;
	let setupError: string | undefined;

	beforeAll(() => {
		const image = webImageInfo();
		if (image.source !== 'NOTESTEAD_WEB_ARTIFACT') {
			setupError = `C1-R1 drives the real upstream web app, but this contract run built the web image from ${image.source}. `
				+ 'Run it with NOTESTEAD_WEB_ARTIFACT=<a CI web-bundle artifact dir> (docs/test-plans/M1-S7.md §How to run).';
			return;
		}
		pos = runInner('c1r1', {});
		neg = runInner('c1r1-neg', { NST_SELFTEST_SECRET_FEED: 'off' });
	}, 75 * minute);

	afterAll(() => {
		if (neg) {
			const n = neg;
			const summary = Object.fromEntries(Object.entries(views(n)).map(([name, v]) => [name, leaksIn(v, n.secrets).map(l => ({ where: l.where.replace(n.run.out, '<run>'), kind: l.kind }))]));
			rmSync(n.run.out, { recursive: true, force: true });
			writeFileSync(join(resultsRoot, 'c1r1-neg-summary.json'), `${JSON.stringify({ exit: n.run.code, durationMs: n.run.durationMs, reached: n.reached, leaks: summary }, null, 2)}\n`);
		}
	});

	const positive = (): Inner => {
		if (setupError) throw new Error(setupError);
		if (!pos) throw new Error('the inner run did not happen (see beforeAll)');
		return pos;
	};

	test('c1r1-ran the real flow reached the settings screen, failed only on purpose, and left nothing behind', () => {
		const p = positive();
		expect({ code: p.run.code === 0 ? 0 : 'non-zero', status: p.result?.status, reached: p.reached }).toEqual({ code: 'non-zero', status: 'failed', reached: 'settings shown' });
		expect((p.result?.errors ?? []).map(e => e.message ?? '').join('\n')).toContain('C1-R1: this failure is deliberate');
		expect((p.result?.errors ?? []).length).toBe(1);
		const labels = p.secrets.map(s => s.label);
		expect(labels).toEqual(expect.arrayContaining(['pertest_account_password', 'pertest_master_password', 'session_id_0']));
		expect(p.leftovers).toEqual([]);
	});

	test('c1r1-planted each channel carries the flow (positive control: the scan below is not vacuous)', () => {
		const p = positive();
		const v = views(p);
		const has = (list: View[], needle: string | RegExp): boolean => list.some(x => (typeof needle === 'string' ? x.text.includes(needle) : needle.test(x.text)));
		expect({
			loginRequest: has(v['trace-network'], '/joplin-server/api/sessions'),
			passwordTyped: has(v['trace-actions'], /"method":"(type|pressSequentially)"/),
			passwordFieldInSnapshot: has(v['trace-actions'], '__playwright_value_'),
			errorContext: v['error-context'].length > 0 && has(v['error-context'], 'Joplin Server password'),
			htmlReport: has(v['html-report'], 'C1-R1: this failure is deliberate'),
			junitReport: has(v['junit-report'], 'C1-R1: this failure is deliberate'),
			console: has(v.console, 'C1-R1: this failure is deliberate'),
		}).toEqual({ loginRequest: true, passwordTyped: true, passwordFieldInSnapshot: true, errorContext: true, htmlReport: true, junitReport: true, console: true });
	});

	for (const channel of ['trace-actions', 'trace-network', 'error-context', 'html-report', 'junit-report', 'json-report', 'console', 'output-files'] as const) {
		test(`c1r1-redacted-${channel} no password and no session id in the ${channel}`, () => {
			const p = positive();
			expect(leakLines(leaksIn(views(p)[channel], p.secrets, [harnessPassword]), p.run.out)).toEqual([]);
		});
	}

	test('c1r1-neg with the secret feed off, the planted values show in the network bodies, actions, snapshots, error-context and HTML report', () => {
		if (setupError) throw new Error(setupError);
		if (!neg) throw new Error('the NEG run did not happen (see beforeAll)');
		const n = neg;
		expect(n.reached).toBe('settings shown');
		const v = views(n);
		const found = (channel: string, label: RegExp): boolean => leaksIn(v[channel], n.secrets.filter(s => label.test(s.label))).length > 0;
		expect({
			networkPassword: found('trace-network', /^pertest_account_password$/),
			networkSession: found('trace-network', /^session_id_/),
			actionsPassword: found('trace-actions', /^pertest_(account|master)_password$/),
			errorContextPassword: found('error-context', /^pertest_account_password$/),
			htmlReport: found('html-report', /^pertest_/),
			detail: n.result ? 'ok' : describeRun(n.run),
		}).toEqual({ networkPassword: true, networkSession: true, actionsPassword: true, errorContextPassword: true, htmlReport: true, detail: 'ok' });
	});
});
