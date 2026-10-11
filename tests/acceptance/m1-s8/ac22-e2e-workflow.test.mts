// M1-AC22 (static half): `.github/workflows/e2e.yml` runs the compose stack, the Playwright E2E suite and the contract
// suites on `ubuntu-24.04` and `ubuntu-24.04-arm`, consuming the x64-built web bundle artifact on both, and uploads
// traces on failure, only through the upload gate (C1-R2) and never with `planted.json` (C5). Plus the other workflow
// requirements M1-S8 routes to the ci-cd specialist (`df`/`free` after T90). The CI half (a green run on both runners
// after the push) is verified from the run's artifacts: docs/test-plans/M1-S8.md §CI evidence.
// These checks read the workflow files with the `yaml` parser, independently of `check:workflows` (which proves the
// pins and permissions; M1-S3 T10 and T11 run it over every workflow, e2e.yml included).
// Contract: docs/test-plans/M1-S8.md §e2e.yml contract (E1 to E12).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { repoRoot } from '../support/repo.mts';

const contract = 'docs/test-plans/M1-S8.md §e2e.yml contract';
const workflowsDir = join(repoRoot, '.github', 'workflows');
const e2ePath = join(workflowsDir, 'e2e.yml');
const runners = ['ubuntu-24.04', 'ubuntu-24.04-arm'] as const;
const x64 = 'ubuntu-24.04';
const arm = 'ubuntu-24.04-arm';

type Dict = Record<string, unknown>;

interface Step {
	index: number;
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with: Dict;
	env: Record<string, string>;
}

interface Job {
	workflow: string;
	id: string;
	runners: string[];
	needs: string[];
	steps: Step[];
	timeoutMinutes?: unknown;
	permissions: unknown;
}

const isDict = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);
const envOf = (v: unknown): Record<string, string> => (isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x) ?? ''])) : {});

const loadWorkflow = (file: string): { doc: Dict; jobs: Job[] } => {
	const doc = parse(readFileSync(join(workflowsDir, file), 'utf8')) as Dict;
	const wfEnv = envOf(doc.env);
	const jobs: Job[] = [];
	for (const [id, raw] of Object.entries(isDict(doc.jobs) ? doc.jobs : {})) {
		if (!isDict(raw)) continue;
		const strategy = isDict(raw.strategy) ? raw.strategy : {};
		const matrix = isDict(strategy.matrix) ? strategy.matrix : {};
		const runsOn = str(raw['runs-on']) ?? '';
		let jobRunners = [runsOn];
		const m = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(runsOn);
		if (m) {
			const values = Array.isArray(matrix[m[1]]) ? (matrix[m[1]] as unknown[]).map(v => str(v) ?? '') : [];
			const included = Array.isArray(matrix.include) ? (matrix.include as unknown[]).filter(isDict).map(e => str(e[m[1]]) ?? '').filter(v => v !== '') : [];
			jobRunners = [...new Set([...values, ...included])];
		}
		const jobEnv = { ...wfEnv, ...envOf(raw.env) };
		const steps: Step[] = (Array.isArray(raw.steps) ? raw.steps : []).filter(isDict).map((s, index) => ({
			index,
			id: str(s.id),
			name: str(s.name),
			uses: str(s.uses),
			run: str(s.run),
			if: str(s.if),
			with: isDict(s.with) ? s.with : {},
			env: { ...jobEnv, ...envOf(s.env) },
		}));
		const needs = Array.isArray(raw.needs) ? raw.needs.map(n => str(n) ?? '') : str(raw.needs) ? [str(raw.needs) ?? ''] : [];
		jobs.push({ workflow: file, id, runners: jobRunners, needs, steps, timeoutMinutes: raw['timeout-minutes'], permissions: raw.permissions });
	}
	return { doc, jobs };
};

const requireE2e = (): { doc: Dict; jobs: Job[] } => {
	assert.ok(existsSync(e2ePath), `M1-AC22 (${contract}): .github/workflows/e2e.yml does not exist`);
	return loadWorkflow('e2e.yml');
};

// One shell command per logical line: continuation backslashes joined.
const commands = (run: string | undefined): string[] => (run ?? '').replace(/\\\n\s*/g, ' ').split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'));
const tokens = (command: string): string[] => command.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, ''));
const action = (step: Step): string => (step.uses ?? '').split('@')[0];

const playwrightCommands = (step: Step): string[][] => commands(step.run).filter(c => /\bplaywright\s+test\b/.test(c)).map(c => {
	const t = tokens(c);
	return t.slice(t.indexOf('test') + 1);
});
const contractCommands = (step: Step): string[][] => commands(step.run).filter(c => /\btest:contract\b|jest\s+(-c|--config)[ =]jest\.contract\.config\.js/.test(c)).map(c => {
	const t = tokens(c);
	const at = t.findIndex(x => x === 'test:contract' || x.startsWith('jest.contract.config') || x.endsWith('jest.contract.config.js'));
	return t.slice(at + 1);
});
// Positional arguments (path filters); options and their values are skipped.
const filters = (args: string[], valued: string[]): string[] => {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '&&' || a === '||' || a === '|' || a === ';' || a.startsWith('>') || a === '2>&1' || a === 'tee') break;
		if (a.startsWith('-')) {
			if (valued.includes(a)) i++;
			continue;
		}
		out.push(a);
	}
	return out;
};
const pwValued = ['-c', '--config', '--project', '--reporter', '--workers', '-j', '--retries', '--output', '--max-failures', '--timeout', '--trace', '--shard'];
const jestValued = ['-c', '--config', '--outputFile', '--maxWorkers', '-w', '--testTimeout', '--reporters', '--shard'];
const forbiddenPw = ['--grep', '-g', '--grep-invert', '--last-failed', '--only-changed', '--pass-with-no-tests', '--list'];
const forbiddenJest = ['-t', '--testNamePattern', '--testPathIgnorePatterns', '--passWithNoTests', '--onlyChanged', '-o', '--onlyFailures', '--listTests'];

const trackedFiles = (pattern: RegExp): string[] => {
	const r = spawnSync('git', ['ls-files', '-z', 'tests'], { cwd: repoRoot, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.split('\0').filter(f => pattern.test(f));
};
const specFiles = (): string[] => trackedFiles(/^tests\/e2e\/.*\.spec\.ts$/);
const contractFiles = (): string[] => trackedFiles(/^tests\/contract\/.*\.test\.ts$/);
const covers = (fs: string[], file: string): boolean => fs.length === 0 || fs.some(f => new RegExp(f).test(file));

const jobsOn = (jobs: Job[], runner: string): Job[] => jobs.filter(j => j.runners.includes(runner));
const playwrightSteps = (jobs: Job[]): { job: Job; step: Step; args: string[] }[] =>
	jobs.flatMap(job => job.steps.flatMap(step => playwrightCommands(step).map(args => ({ job, step, args }))));
const contractSteps = (jobs: Job[]): { job: Job; step: Step; args: string[] }[] =>
	jobs.flatMap(job => job.steps.flatMap(step => contractCommands(step).map(args => ({ job, step, args }))));
const runsTests = (job: Job): boolean => playwrightSteps([job]).length > 0 || contractSteps([job]).length > 0;
const where = (job: Job, step?: Step): string => `${job.workflow} job "${job.id}"${step ? ` step ${step.index + 1}${step.name ? ` "${step.name}"` : ''}` : ''}`;

const bundleSteps = (job: Job): Step[] => job.steps.filter(s =>
	(action(s) === 'actions/download-artifact' && (str(s.with.name) ?? '').startsWith('web-bundle-'))
	|| (action(s) === 'actions/cache/restore' && (str(s.with.key) ?? '').startsWith('web-bundle-')));
const buildsBundle = (step: Step): boolean => /test:optin:build|ac5-build\.optin|web-build\s+build|workspace\s+web-build\s+build|yarn\s+web\b/.test(step.run ?? '');
const norm = (p: string): string => p.trim().replace(/\/+$/, '');

const gateCommand = /\bnode\s+tests\/harness\/upload-gate\.ts\b/;
const isResultsUpload = (s: Step): boolean => action(s) === 'actions/upload-artifact' && /test-results|playwright-report/.test(str(s.with.path) ?? '');

describe('M1-AC22 e2e.yml (static)', () => {
	it('M1-S8-E01 e2e.yml exists, has push and workflow_dispatch triggers, and every job is least privilege with a timeout', () => {
		const { doc, jobs } = requireE2e();
		const on = doc.on;
		const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(v => str(v) ?? '') : isDict(on) ? Object.keys(on) : [];
		assert.ok(triggers.includes('push') && triggers.includes('workflow_dispatch'), `triggers: ${JSON.stringify(triggers)}`);
		assert.ok(jobs.length > 0, 'e2e.yml has no jobs');
		for (const job of jobs) {
			assert.ok(job.permissions !== undefined, `${where(job)} declares no permissions`);
			assert.ok(!/write/.test(JSON.stringify(job.permissions)), `${where(job)} grants a write scope: ${JSON.stringify(job.permissions)}`);
			assert.ok(typeof job.timeoutMinutes === 'number' && job.timeoutMinutes > 0, `${where(job)} has no timeout-minutes (a hung stack must end the job, and the upload gate must still run)`);
		}
	});

	for (const runner of runners) {
		it(`M1-S8-E02-${runner} on ${runner}: Playwright runs every tests/e2e spec, unfiltered, with NOTESTEAD_WEB_ARTIFACT set`, () => {
			const { jobs } = requireE2e();
			const pw = playwrightSteps(jobsOn(jobs, runner));
			assert.ok(pw.length > 0, `no step on ${runner} runs \`corepack yarn playwright test\``);
			for (const { job, step, args } of pw) {
				const bad = args.filter(a => forbiddenPw.some(f => a === f || a.startsWith(`${f}=`)));
				assert.deepEqual(bad, [], `${where(job, step)} narrows the run`);
				assert.ok((step.env.NOTESTEAD_WEB_ARTIFACT ?? '') !== '', `${where(job, step)}: NOTESTEAD_WEB_ARTIFACT is not set (the walking skeleton refuses fixture F3)`);
			}
			const missing = specFiles().filter(f => !pw.some(p => covers(filters(p.args, pwValued), f)));
			assert.deepEqual(missing, [], `specs not run on ${runner}`);
		});

		it(`M1-S8-E03-${runner} on ${runner}: the contract layer runs every tests/contract test file, with Jest JSON results, and NOTESTEAD_WEB_ARTIFACT for tests/contract/m1-s7`, () => {
			const { jobs } = requireE2e();
			const cs = contractSteps(jobsOn(jobs, runner));
			assert.ok(cs.length > 0, `no step on ${runner} runs \`corepack yarn test:contract\``);
			for (const { job, step, args } of cs) {
				const bad = args.filter(a => forbiddenJest.some(f => a === f || a.startsWith(`${f}=`)));
				assert.deepEqual(bad, [], `${where(job, step)} narrows the run`);
				assert.ok(args.includes('--json') && args.some(a => a.startsWith('--outputFile=test-results/') || a === '--outputFile'), `${where(job, step)}: no Jest JSON results under test-results/ (--json --outputFile=test-results/…)`);
				const fs = filters(args, jestValued);
				if (contractFiles().some(f => f.startsWith('tests/contract/m1-s7/') && covers(fs, f))) {
					assert.ok((step.env.NOTESTEAD_WEB_ARTIFACT ?? '') !== '', `${where(job, step)} runs tests/contract/m1-s7 without NOTESTEAD_WEB_ARTIFACT`);
				}
			}
			const missing = contractFiles().filter(f => !cs.some(c => covers(filters(c.args, jestValued), f)));
			assert.deepEqual(missing, [], `contract test files not run on ${runner}`);
		});

		it(`M1-S8-E04-${runner} on ${runner}: NOTESTEAD_WEB_ARTIFACT is the downloaded or restored x64 bundle, checked with sha256sum -c and its SHA256SUMS written to the job summary`, () => {
			const { jobs } = requireE2e();
			const testJobs = jobsOn(jobs, runner).filter(runsTests);
			assert.ok(testJobs.length > 0, `no test job on ${runner}`);
			for (const job of testJobs) {
				const bundles = bundleSteps(job);
				assert.ok(bundles.length > 0, `${where(job)}: no actions/download-artifact (name web-bundle-…) or actions/cache/restore (key web-bundle-…) step`);
				const paths = bundles.map(b => norm(str(b.with.path) ?? ''));
				for (const s of [...playwrightSteps([job]), ...contractSteps([job])].map(x => x.step)) {
					const value = s.env.NOTESTEAD_WEB_ARTIFACT;
					if (value) assert.ok(paths.includes(norm(value)), `${where(job, s)}: NOTESTEAD_WEB_ARTIFACT=${value} is not the bundle step's path (${paths.join(', ')})`);
				}
				for (const b of bundles.filter(x => action(x) === 'actions/cache/restore')) {
					assert.equal(str(b.with['fail-on-cache-miss']), 'true', `${where(job, b)}: a cache miss must fail the job, never fall back to a build`);
				}
				const firstTest = Math.min(...[...playwrightSteps([job]), ...contractSteps([job])].map(x => x.step.index));
				const checked = job.steps.some(s => s.index > Math.min(...bundles.map(b => b.index)) && s.index < firstTest
					&& /sha256sum\b[^\n]*(-c\b|--check\b)/.test(s.run ?? '') && /SHA256SUMS[\s\S]*GITHUB_STEP_SUMMARY|GITHUB_STEP_SUMMARY[\s\S]*SHA256SUMS/.test(s.run ?? ''));
				assert.ok(checked, `${where(job)}: between the bundle step and the first test step, a step must run \`sha256sum -c SHA256SUMS\` in the bundle dir and write SHA256SUMS to $GITHUB_STEP_SUMMARY (CI evidence E4)`);
			}
		});
	}

	it('M1-S8-E05 the bundle is built on x64 only: no arm64 job and no test job builds it; a same-run artifact comes from an ubuntu-24.04 job the test jobs need', () => {
		const { jobs } = requireE2e();
		for (const job of jobs) {
			const building = job.steps.filter(buildsBundle);
			if (job.runners.includes(arm) || runsTests(job)) assert.deepEqual(building.map(s => where(job, s)), [], 'builds the web bundle');
			if (job.runners.includes(arm)) {
				const saves = job.steps.filter(s => /^actions\/cache(\/save)?$/.test(action(s)) && (str(s.with.key) ?? '').startsWith('web-bundle-'));
				assert.deepEqual(saves.map(s => where(job, s)), [], 'an arm64 job saves a web-bundle cache entry');
			}
		}
		const byId = new Map(jobs.map(j => [j.id, j]));
		const upstream = (job: Job, seen = new Set<string>()): Job[] => job.needs.flatMap(n => {
			const j = byId.get(n);
			if (!j || seen.has(n)) return [];
			seen.add(n);
			return [j, ...upstream(j, seen)];
		});
		for (const job of jobs.filter(runsTests)) {
			for (const b of bundleSteps(job).filter(s => action(s) === 'actions/download-artifact' && s.with['run-id'] === undefined)) {
				const name = str(b.with.name) ?? '';
				const producers = upstream(job).filter(p => p.steps.some(s => action(s) === 'actions/upload-artifact' && str(s.with.name) === name));
				assert.ok(producers.length > 0, `${where(job, b)}: no job in its needs uploads ${name}`);
				for (const p of producers) assert.deepEqual(p.runners, [x64], `${where(p)} uploads ${name} but does not run on ${x64} only`);
			}
		}
	});

	it('M1-S8-E06 the bundle job (if any) reuses web-bundle.yml\'s cache key and T90 path, so a cache hit and a build give the same artifact', () => {
		const { jobs } = requireE2e();
		const webBundle = readFileSync(join(workflowsDir, 'web-bundle.yml'), 'utf8');
		const savedKey = /key:\s*(web-bundle-\$\{\{[^\n]+)/.exec(webBundle)?.[1]?.trim();
		assert.ok(savedKey, 'web-bundle.yml saves no web-bundle-… cache key');
		for (const job of jobs) {
			for (const s of job.steps.filter(x => /^actions\/cache(\/restore|\/save)?$/.test(action(x)) && (str(x.with.key) ?? '').startsWith('web-bundle-'))) {
				assert.equal((str(s.with.key) ?? '').trim(), savedKey, `${where(job, s)}: the key must equal web-bundle.yml's`);
			}
			for (const s of job.steps.filter(buildsBundle)) {
				assert.ok(/ac5-build\.optin\.mts/.test(s.run ?? ''), `${where(job, s)}: a bundle build in e2e.yml runs as M1-S2's T90 (tests/acceptance/m1-s2/optin/ac5-build.optin.mts), as web-bundle.yml does`);
			}
		}
	});

	it('M1-S8-E07 Playwright\'s own Chromium is installed (only Chromium, the pinned Playwright), and no NOTESTEAD_CHROMIUM override', () => {
		const { jobs } = requireE2e();
		for (const { job } of playwrightSteps(jobs)) {
			const install = job.steps.find(s => /\bplaywright\s+install\b/.test(s.run ?? ''));
			assert.ok(install, `${where(job)}: no \`corepack yarn playwright install … chromium\` step`);
			assert.ok(/\bchromium\b/.test(install.run ?? '') && !/\b(firefox|webkit)\b/.test(install.run ?? ''), `${where(job, install)} must install Chromium only`);
			assert.ok(!/\bnpx\b|@playwright\/test@|playwright@/.test(install.run ?? ''), `${where(job, install)} must use the repo's pinned Playwright (corepack yarn playwright install), not npx or another version`);
			for (const s of job.steps) assert.ok(!s.env.NOTESTEAD_CHROMIUM, `${where(job, s)} sets NOTESTEAD_CHROMIUM`);
		}
	});
});

describe('C1-R2 and C5: test results are uploaded only through the upload gate (every workflow that runs Playwright or contract tests)', () => {
	it('M1-S8-E08 every job that runs Playwright or the contract layer uploads test-results/playwright-report only after `node tests/harness/upload-gate.ts` (if: always()) succeeded, and never planted.json', () => {
		const files = readdirSync(workflowsDir).filter(f => /\.ya?ml$/.test(f));
		assert.ok(files.includes('e2e.yml'), `M1-AC22 (${contract}): .github/workflows/e2e.yml does not exist`);
		const testJobs = files.flatMap(f => loadWorkflow(f).jobs).filter(runsTests);
		assert.ok(testJobs.some(j => j.workflow === 'e2e.yml'), 'no e2e.yml job runs Playwright or the contract layer');
		for (const job of testJobs) {
			const lastTest = Math.max(...[...playwrightSteps([job]), ...contractSteps([job])].map(x => x.step.index));
			const gates = job.steps.filter(s => gateCommand.test(s.run ?? ''));
			assert.ok(gates.length > 0, `${where(job)}: no step runs \`node tests/harness/upload-gate.ts\``);
			const gate = gates[0];
			assert.ok(gate.index > lastTest, `${where(job, gate)}: the gate must run after the last test step`);
			assert.ok(/\balways\(\)/.test(gate.if ?? ''), `${where(job, gate)}: the gate needs if: always() (it must run after a failure, a cancellation or a timeout)`);
			assert.ok(gate.id, `${where(job, gate)}: the gate step needs an id, so the uploads can require its outcome`);
			const uploads = job.steps.filter(isResultsUpload);
			assert.ok(uploads.length > 0, `${where(job)} uploads no test results (M1-AC22: traces are uploaded on failure; CI evidence)`);
			for (const u of uploads) {
				assert.ok(u.index > gate.index, `${where(job, u)} uploads before the gate`);
				const cond = u.if ?? '';
				assert.ok(new RegExp(`steps\\.${gate.id}\\.(outcome|conclusion)\\s*==\\s*'success'`).test(cond), `${where(job, u)}: if: must require steps.${gate.id}.outcome == 'success' (found ${JSON.stringify(cond)})`);
				assert.ok(/\balways\(\)|\bfailure\(\)/.test(cond), `${where(job, u)}: if: must also run on failure (always() or failure()), so traces of a failing run are uploaded`);
				assert.ok(/^\s*!\*\*\/planted\.json\s*$/m.test(str(u.with.path) ?? ''), `${where(job, u)}: path must exclude !**/planted.json (C5)`);
			}
			const names = uploads.map(u => str(u.with.name) ?? '');
			if (job.runners.length > 1) for (const n of names) assert.ok(/\$\{\{\s*matrix\./.test(n), `${where(job)}: artifact name ${n} must differ per runner`);
		}
	});

	it('M1-S8-E09 the gate exists as a QA harness script (tests/harness/upload-gate.ts)', () => {
		assert.ok(existsSync(join(repoRoot, 'tests', 'harness', 'upload-gate.ts')), 'tests/harness/upload-gate.ts (QA) does not exist yet');
	});
});

describe('M1-S8 follow-ups on web-bundle.yml', () => {
	it('M1-S8-E10 web-bundle.yml records `df` and `free` after T90, even when T90 failed', () => {
		const { jobs } = loadWorkflow('web-bundle.yml');
		const build = jobs.find(j => j.steps.some(s => s.id === 't90'));
		assert.ok(build, 'web-bundle.yml has no step with id t90');
		const t90 = build.steps.find(s => s.id === 't90');
		assert.ok(t90);
		const after = build.steps.filter(s => s.index > t90.index && /\bdf\b/.test(s.run ?? '') && /\bfree\b/.test(s.run ?? ''));
		assert.ok(after.length > 0, `${where(build)}: no step after T90 runs df and free`);
		assert.ok(after.some(s => /\balways\(\)/.test(s.if ?? '')), `${where(build)}: the df/free step needs if: always()`);
	});
});
