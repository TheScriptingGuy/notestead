// Runs one harness self-test spec (tests/harness/selftest/*.spec.ts) in its own Playwright process, as a user would run
// Playwright, and returns its exit code, console output and JSON report (docs/test-plans/M1-S6.md §Harness self-tests).
// The images under test come from this contract run: the `web` image of globalSetup, the headless and device images
// built lazily by the M1-S5 helpers, so the inner run builds nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from '../../support/redact.ts';
import { deviceImage, headlessImage } from './headless.ts';
import { repoRoot, webImageInfo } from './podman.ts';

export const story = 'm1-s6';
export const resultsDir = join(repoRoot, 'test-results', 'contract', story);

export interface PwAttachment {
	name: string;
	path?: string;
	body?: string;
	contentType: string;
}

export interface PwResult {
	status: string;
	errors: { message?: string }[];
	attachments: PwAttachment[];
}

export interface PwSpec {
	title: string;
	tests: { results: PwResult[] }[];
}

export interface PwSuite {
	title: string;
	specs?: PwSpec[];
	suites?: PwSuite[];
}

export interface PwReport {
	suites: PwSuite[];
	errors: { message?: string }[];
	stats: { expected: number; unexpected: number; flaky: number; skipped: number };
}

export interface SelftestRun {
	code: number | null;
	output: string;
	out: string;
	log: string;
	report?: PwReport;
	durationMs: number;
}

export const allSpecs = (suites: PwSuite[]): PwSpec[] => suites.flatMap(s => [...(s.specs ?? []), ...allSpecs(s.suites ?? [])]);

export const stackImagesEnv = (): Record<string, string> => ({
	NOTESTEAD_WEB_IMAGE: webImageInfo().image,
	NOTESTEAD_HEADLESS_IMAGE: headlessImage(),
	NOTESTEAD_DEVICE_IMAGE: deviceImage(),
});

// `env` entries set to undefined are removed from the inner environment.
export const runSelftest = (label: string, spec: string, env: Record<string, string | undefined> = {}, timeoutMs = 25 * 60_000): SelftestRun => {
	const out = join(resultsDir, label);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const childEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', NST_SELFTEST_OUT: out };
	for (const key of ['JOPLIN_SERVER_URL', 'NOTESTEAD_STACK_OVERRIDES', 'JEST_WORKER_ID', 'NODE_OPTIONS', 'CI']) delete childEnv[key];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const started = Date.now();
	const r = spawnSync('corepack', ['yarn', 'playwright', 'test', '-c', 'tests/harness/playwright.selftest.config.ts', spec], {
		cwd: repoRoot, env: childEnv, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
	});
	const durationMs = Date.now() - started;
	const output = `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}` : ''}`;
	const log = join(out, 'playwright-console.log');
	writeFileSync(log, redactText(`$ corepack yarn playwright test -c tests/harness/playwright.selftest.config.ts ${spec}\n# exit ${r.status} signal ${r.signal} after ${durationMs} ms\n${output}`));
	const reportFile = join(out, 'report.json');
	const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) as PwReport : undefined;
	return { code: r.status, output, out, log, report, durationMs };
};

export const describeRun = (run: SelftestRun): string => `inner Playwright exit ${run.code} after ${run.durationMs} ms; log ${run.log}; tail:\n${redactText(run.output).slice(-2500)}`;
