// CI run 39663284028, Diagnosis B and D (docs/test-plans/CI-M2-S2-x64-arm64.md Decisions B): no Playwright action was
// bounded, so a click on an element that never became actionable hung an arm64 test for 23 minutes, the 45-minute step
// limit killed Playwright before its reporters finished, and the upload gate (correctly) removed the unredacted output.
// These checks read the real config, the specs and e2e.yml, and tie the bounds together: every action and navigation
// has a timeout, every spec is bounded, a test plus its CI retry fits the run's global timeout, and the global timeout
// ends Playwright at least four minutes before the E2E step does.
// CI-T-01: playwright.config.ts uses the constants of tests/e2e/support/timeouts.ts. CI-T-02: the global timeout fits the
// step limit of e2e.yml. CI-T-03: no spec sets a timeout above longSpecTimeoutMs; the M2-S2 specs use it. CI-T-04: two
// attempts of the longest spec fit the global timeout.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { repoRoot } from '../support/repo.mts';

const plan = 'docs/test-plans/CI-M2-S2-x64-arm64.md';
const e2eDir = join(repoRoot, 'tests', 'e2e');
const configPath = join(repoRoot, 'playwright.config.ts');
const e2eWorkflow = join(repoRoot, '.github', 'workflows', 'e2e.yml');
const marginMinutes = 4;

interface Timeouts { actionTimeoutMs: number; navigationTimeoutMs: number; ciGlobalTimeoutMs: number; longSpecTimeoutMs: number }

// Loaded inside each test, so a missing module fails each of them with its own message.
const loadTimeouts = async (): Promise<Timeouts> => {
	const path = join(e2eDir, 'support', 'timeouts.ts');
	assert.ok(existsSync(path), `${plan} Decisions B: tests/e2e/support/timeouts.ts does not exist`);
	return (await import(pathToFileURL(path).href)) as Timeouts;
};

interface LoadedConfig { globalTimeout?: number; use?: { actionTimeout?: number; navigationTimeout?: number } }

// The config as Playwright would see it, evaluated with CI set or not (it reads process.env.CI when it is loaded).
const loadConfig = async (ci: boolean): Promise<LoadedConfig> => {
	const saved = process.env.CI;
	if (ci) process.env.CI = '1';
	else delete process.env.CI;
	try {
		const module = (await import(`${pathToFileURL(configPath).href}?ci=${ci}`)) as { default: LoadedConfig };
		return module.default;
	} finally {
		if (saved === undefined) delete process.env.CI;
		else process.env.CI = saved;
	}
};

const specFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
	const path = join(dir, e.name);
	if (e.isDirectory()) return specFiles(path);
	return e.name.endsWith('.spec.ts') ? [path] : [];
});

// The e2e step of .github/workflows/e2e.yml (id: e2e) and its timeout-minutes.
const e2eStepMinutes = (): number => {
	const doc = parse(readFileSync(e2eWorkflow, 'utf8')) as { jobs?: Record<string, { steps?: { id?: string; 'timeout-minutes'?: unknown }[] }> };
	const steps = Object.values(doc.jobs ?? {}).flatMap(j => j.steps ?? []).filter(s => s.id === 'e2e');
	assert.equal(steps.length, 1, 'e2e.yml has exactly one step with id: e2e');
	const minutes = steps[0]['timeout-minutes'];
	assert.equal(typeof minutes, 'number', 'the e2e step has a numeric timeout-minutes');
	return minutes as number;
};

// A timeout expression in a spec: a number, `longSpecTimeoutMs`, or a product/sum of them.
const evaluate = (expression: string, file: string, longSpecTimeoutMs: number): number => {
	const text = expression.replace(/\blongSpecTimeoutMs\b/g, String(longSpecTimeoutMs)).replace(/_/g, '');
	assert.match(text, /^[0-9\s*+]+$/, `${file}: cannot evaluate the timeout expression "${expression}"`);
	return text.split('+').reduce((sum, term) => sum + term.split('*').reduce((product, factor) => product * Number(factor.trim()), 1), 0);
};

const specTimeouts = (longSpecTimeoutMs: number): { file: string; expression: string; ms: number }[] => specFiles(e2eDir).flatMap(path => {
	const file = relative(repoRoot, path);
	const source = readFileSync(path, 'utf8');
	assert.doesNotMatch(source, /\bslow\(\)/, `${file}: test.slow() would triple the timeout`);
	const found: { file: string; expression: string; ms: number }[] = [];
	for (const m of source.matchAll(/describe\.configure\(\{[^}]*?\btimeout:\s*([^,}]+?)\s*[,}]/g)) found.push({ file, expression: m[1], ms: evaluate(m[1], file, longSpecTimeoutMs) });
	for (const m of source.matchAll(/\.setTimeout\(\s*([^)]+?)\s*\)/g)) found.push({ file, expression: m[1], ms: evaluate(m[1], file, longSpecTimeoutMs) });
	return found;
});

describe('CI-M2-S2 bounded actions, specs and run (CI 39663284028 B, D)', () => {
	it('CI-T-01 playwright.config.ts bounds every action and navigation, and the CI run', async () => {
		const t = await loadTimeouts();
		const source = readFileSync(configPath, 'utf8');
		for (const name of ['actionTimeoutMs', 'navigationTimeoutMs', 'ciGlobalTimeoutMs']) {
			assert.match(source, new RegExp(`\\b${name}\\b`), `playwright.config.ts uses ${name} from tests/e2e/support/timeouts.ts`);
		}
		const local = await loadConfig(false);
		const ci = await loadConfig(true);
		assert.equal(local.use?.actionTimeout, t.actionTimeoutMs, 'use.actionTimeout is actionTimeoutMs (default 0 = none)');
		assert.equal(local.use?.navigationTimeout, t.navigationTimeoutMs, 'use.navigationTimeout is navigationTimeoutMs (default 0 = none)');
		assert.equal(ci.use?.actionTimeout, t.actionTimeoutMs, 'the same in CI');
		assert.equal(ci.globalTimeout, t.ciGlobalTimeoutMs, 'in CI the whole run is bounded');
		assert.ok(!local.globalTimeout, 'locally the run is not bounded by the CI limit');
		assert.ok(t.actionTimeoutMs > 0 && t.actionTimeoutMs <= 60_000, `an action fails within a minute (${t.actionTimeoutMs} ms)`);
		assert.ok(t.navigationTimeoutMs > 0 && t.navigationTimeoutMs <= 120_000, `a navigation fails within two minutes (${t.navigationTimeoutMs} ms)`);
	});

	it('CI-T-02 the CI global timeout ends Playwright at least four minutes before the E2E step does', async () => {
		const t = await loadTimeouts();
		const minutes = e2eStepMinutes();
		const limit = (minutes - marginMinutes) * 60_000;
		assert.ok(t.ciGlobalTimeoutMs <= limit, `ciGlobalTimeoutMs ${t.ciGlobalTimeoutMs / 60_000} min must be at most ${minutes - marginMinutes} min: the step has ${minutes} min and ${marginMinutes} min cover globalTeardown's stack removal and the reporters' onEnd (${plan} Budget)`);
	});

	it('CI-T-03 no spec sets a timeout above longSpecTimeoutMs, and the three M2-S2 specs use it', async () => {
		const t = await loadTimeouts();
		const all = specTimeouts(t.longSpecTimeoutMs);
		for (const e of all) assert.ok(e.ms <= t.longSpecTimeoutMs, `${e.file}: timeout ${e.expression} = ${e.ms / 60_000} min is above longSpecTimeoutMs (${t.longSpecTimeoutMs / 60_000} min)`);
		for (const spec of ['notes.spec.ts', 'notebooks-tags.spec.ts', 'todos.spec.ts']) {
			const source = readFileSync(join(e2eDir, 'm2-s2', spec), 'utf8');
			assert.match(source, /describe\.configure\(\{ timeout: longSpecTimeoutMs \}\)/, `tests/e2e/m2-s2/${spec} sets test.describe.configure({ timeout: longSpecTimeoutMs })`);
		}
	});

	it('CI-T-04 a test and its CI retry fit inside the global timeout', async () => {
		const t = await loadTimeouts();
		assert.ok(2 * t.longSpecTimeoutMs < t.ciGlobalTimeoutMs, `2 x ${t.longSpecTimeoutMs / 60_000} min must stay below the ${t.ciGlobalTimeoutMs / 60_000} min global timeout`);
	});
});
