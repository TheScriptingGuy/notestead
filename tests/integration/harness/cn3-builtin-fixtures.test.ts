// C-N3 on a real Playwright process (review M1-S7-r1 C-N3; docs/test-plans/M2-S1.md): Playwright's built-in `page` and
// `context` fixtures record no trace in this harness (use.trace is off; the webApp fixture records its own), so a spec
// that asks for one fails with a message that names `webApp`. The inner control test asks for neither and passes.
// No stack and no service: the worker gets a fake stack descriptor, and the failing tests never launch a browser.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from '../../support/repoRoot.ts';

const repoRoot = findRepoRoot();
const minute = 60_000;

interface JsonSpec {
	title: string;
	tests: { results: { status: string; error?: { message?: string } }[] }[];
}
interface JsonSuiteReal {
	specs?: JsonSpec[];
	suites?: JsonSuiteReal[];
}
const specsOf = (suite: JsonSuiteReal): JsonSpec[] => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specsOf)];

describe('C-N3 built-in page and context fixtures', () => {
	let base: string | undefined;
	let code: number | null = null;
	let output = '';
	let specs: JsonSpec[] = [];

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), 'nst-cn3-'));
		const out = join(base, 'run');
		const stack = {
			project: 'nst-cn3', run: 'cn3', owned: false, overrides: [], images: { server: '', web: '', headless: '', device: '', built: [] },
			workDir: base, logsDir: join(base, 'logs'), frontNetwork: '', backNetwork: '', containers: {}, accounts: [], headless: [],
		};
		const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', NST_CN3_OUT: out, NOTESTEAD_E2E_STACK: JSON.stringify(stack) };
		for (const key of ['CI', 'JEST_WORKER_ID', 'NODE_OPTIONS', 'JOPLIN_SERVER_URL']) delete env[key];
		for (const key of Object.keys(env)) if (key.startsWith('NST_SELFTEST_')) delete env[key];
		const r = spawnSync('corepack', ['yarn', 'playwright', 'test', '-c', 'tests/harness/playwright.cn3.config.ts'], { cwd: repoRoot, env, encoding: 'utf8', timeout: 3 * minute });
		code = r.status;
		output = `${r.stdout}${r.stderr}`;
		try {
			specs = specsOf(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as JsonSuiteReal);
		} catch {
			specs = [];
		}
	}, 4 * minute);

	afterAll(() => {
		if (base) rmSync(base, { recursive: true, force: true });
	});

	const resultOf = (title: string): { status: string; message: string } => {
		const spec = specs.find(s => s.title === title);
		const result = spec?.tests[0]?.results[0];
		return { status: result?.status ?? `(no result; exit ${String(code)}; ${output.slice(-500)})`, message: result?.error?.message ?? '' };
	};

	test('c-n3-01 the inner run fails (exit 1) with exactly one passed and two failed tests', () => {
		const statuses = specs.map(s => `${s.title}: ${s.tests[0]?.results[0]?.status ?? 'none'}`).sort();
		expect({ code, statuses }).toEqual({
			code: 1,
			statuses: ['C-N3 inner context: failed', 'C-N3 inner control: passed', 'C-N3 inner page: failed'],
		});
	});

	test('c-n3-02 a test asking for page fails with the message naming webApp', () => {
		const r = resultOf('C-N3 inner page');
		expect(r.status).toBe('failed');
		expect(r.message).toContain('the built-in `page` fixture is disabled');
		expect(r.message).toContain('Use the `webApp` fixture');
	});

	test('c-n3-03 a test asking for context fails the same way', () => {
		const r = resultOf('C-N3 inner context');
		expect(r.status).toBe('failed');
		expect(r.message).toContain('the built-in `context` fixture is disabled');
		expect(r.message).toContain('Use the `webApp` fixture');
	});
});
