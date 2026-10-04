// M1-AC1: the yarn 4 workspace installs, lints and tests green on the Pi; every package has a real unit test;
// lint rejects focused/skipped tests and fixed sleeps, and type-checks. Test plan: docs/test-plans/M1-S1.md.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, describeRun, fixturesDir, gitStatus, lintReported, listFiles,
	placeTemporarily, readPin, repoRoot, requireRootScript, rootManifest, workspacePackages, yarn, yarnScript,
} from '../support/repo.mts';
import type { RunResult, Workspace } from '../support/repo.mts';

const story = 'm1-s1';
const minute = 60_000;
const lintFixtures = join(fixturesDir, 'm1-s1', 'lint');
const testFilePattern = /\.test\.(ts|tsx|mts|cts)$/;

const allDependencies = (): Map<string, string> => {
	const deps = new Map<string, string>();
	for (const m of [rootManifest(), ...workspacePackages().map(w => w.manifest)]) {
		for (const [k, v] of Object.entries({ ...m.dependencies, ...m.devDependencies })) deps.set(k, v);
	}
	return deps;
};

const requireWorkspaces = (): Workspace[] => {
	const ws = workspacePackages();
	assert.ok(ws.length > 0, 'M1-S1 scaffold missing: no workspace packages under packages/*/package.json');
	return ws;
};

const unitTestFiles = (w: Workspace): string[] => listFiles(w.dir).filter(f => testFilePattern.test(f));

describe('M1-AC1 scaffold (static contract, ADR-0005/0009)', () => {
	it('M1-S1-T01 root manifest declares the yarn 4 workspace, AGPL licence and the contract scripts', () => {
		const m = rootManifest();
		assert.match(m.packageManager ?? '', /^yarn@4\.\d+\.\d+(\+.*)?$/, 'packageManager must pin yarn 4 (corepack)');
		assert.equal(m.private, true, 'the workspace root must be private');
		assert.equal(m.license, 'AGPL-3.0-or-later', 'root licence');
		const workspaces = Array.isArray(m.workspaces) ? m.workspaces : m.workspaces?.packages ?? [];
		assert.ok(workspaces.includes('packages/*'), `workspaces must include "packages/*", got ${JSON.stringify(workspaces)}`);
		for (const script of ['lint', 'test', 'check:pin', 'check:no-upstream-copy']) requireRootScript(script);
	});

	it('M1-S1-T01b .yarnrc.yml uses the node-modules linker and a minimal age gate, as upstream', () => {
		const path = join(repoRoot, '.yarnrc.yml');
		assert.ok(existsSync(path), 'M1-S1 scaffold missing: .yarnrc.yml');
		const rc = readFileSync(path, 'utf8');
		assert.match(rc, /^nodeLinker:\s*["']?node-modules["']?\s*$/m, 'nodeLinker must be node-modules');
		assert.match(rc, /^npmMinimalAgeGate:\s*\S+/m, 'npmMinimalAgeGate must be set');
	});

	it('M1-S1-T01c every workspace package is AGPL-3.0-or-later and the tooling is declared', () => {
		for (const w of requireWorkspaces()) {
			assert.equal(w.manifest.license, 'AGPL-3.0-or-later', `${w.rel}/package.json licence`);
		}
		const deps = allDependencies();
		for (const tool of ['typescript', 'eslint', 'jest', '@playwright/test', 'eslint-plugin-jest', 'eslint-plugin-playwright', '@types/node']) {
			assert.ok(deps.has(tool), `tooling not declared in any manifest: ${tool}`);
		}
	});

	it('M1-S1-T01d a workspace depends on the pinned CLI exactly (ADR-0005 §1: "joplin": "<cli.version>")', () => {
		const pin = readPin();
		const declaring = requireWorkspaces().filter(w => w.manifest.dependencies?.joplin !== undefined);
		assert.ok(declaring.length > 0, 'no workspace declares a "joplin" dependency (ADR-0005 puts it in packages/headless)');
		for (const w of declaring) {
			assert.equal(w.manifest.dependencies?.joplin, pin.cli.version, `${w.rel}: "joplin" must be exactly ${pin.cli.version}, not a range`);
		}
	});
});

describe('M1-AC1 install, lint and test are green on this machine', () => {
	it('M1-S1-T02 `corepack yarn install --immutable` exits 0 (lockfile committed and consistent)', { timeout: 31 * minute }, () => {
		rootManifest();
		assertExitZero(yarn(story, 'T02-install', ['install', '--immutable'], { timeoutMs: 30 * minute }));
	});

	it('M1-S1-T03 `corepack yarn lint` exits 0', { timeout: 11 * minute }, () => {
		assertExitZero(yarnScript(story, 'T03-lint', 'lint', [], { timeoutMs: 10 * minute }));
	});

	it('M1-S1-T04 `corepack yarn test` exits 0 and runs at least one real unit test file of every package', { timeout: 21 * minute }, () => {
		const workspaces = requireWorkspaces();
		const r = yarnScript(story, 'T04-test', 'test', [], { timeoutMs: 20 * minute });
		assertExitZero(r);
		for (const w of workspaces) {
			const files = unitTestFiles(w);
			assert.ok(files.length > 0, `${w.rel} has no *.test.ts file (M1-AC1: every package has at least one real unit test)`);
			const withAssertions = files.filter(f => /\bexpect\s*\(/.test(readFileSync(f, 'utf8')));
			assert.ok(withAssertions.length > 0, `${w.rel}: no test file contains an expect(...) assertion`);
			const ran = withAssertions.filter(f => new RegExp(`\\bPASS\\b.*${basename(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(r.output));
			assert.ok(ran.length > 0, `${w.rel}: none of ${withAssertions.map(f => relative(repoRoot, f)).join(', ')} was reported as PASS by \`corepack yarn test\`. ${describeRun(r)}`);
		}
	});

	it('M1-S1-T05 Playwright is wired (`corepack yarn playwright --version`)', { timeout: 3 * minute }, () => {
		rootManifest();
		const r = yarn(story, 'T05-playwright-version', ['playwright', '--version'], { timeoutMs: 2 * minute });
		assertExitZero(r);
		assert.match(r.output, /Version 1\.\d+\.\d+/, `unexpected Playwright version output. ${describeRun(r)}`);
	});
});

describe('M1-AC1 NEG: lint rejects focused/skipped tests and fixed sleeps (one lint run)', () => {
	let result: RunResult | undefined;
	let cleanup: (() => void) | undefined;
	let statusBefore: string | undefined;
	let packageFixture = '';
	const testsFocused = 'tests/unit/__lint_neg__/focused.test.ts';
	const testsDisabled = 'tests/unit/__lint_neg__/disabled.test.ts';
	const e2eSkipped = 'tests/e2e/__lint_neg__/skipped.spec.ts';
	const e2eSleep = 'tests/e2e/__lint_neg__/sleep.spec.ts';

	before(() => {
		requireRootScript('lint');
		const target = requireWorkspaces().find(w => existsSync(join(w.dir, 'src')));
		assert.ok(target, 'no workspace package has a src/ directory to host the package-level lint fixture');
		packageFixture = `${target.rel}/src/__lint_neg__/focused.test.ts`;
		statusBefore = gitStatus();
		cleanup = placeTemporarily([
			{ from: join(lintFixtures, 'focused.test.ts.fixture'), to: join(repoRoot, testsFocused) },
			{ from: join(lintFixtures, 'disabled.test.ts.fixture'), to: join(repoRoot, testsDisabled) },
			{ from: join(lintFixtures, 'skipped.spec.ts.fixture'), to: join(repoRoot, e2eSkipped) },
			{ from: join(lintFixtures, 'sleep.spec.ts.fixture'), to: join(repoRoot, e2eSleep) },
			{ from: join(lintFixtures, 'focused.test.ts.fixture'), to: join(repoRoot, packageFixture) },
		]);
		result = yarnScript(story, 'T06-lint-neg', 'lint', [], { timeoutMs: 10 * minute });
	});

	after(() => {
		cleanup?.();
		if (statusBefore !== undefined) assert.equal(gitStatus(), statusBefore, 'lint NEG fixtures were not cleaned up');
	});

	const lintRun = (): RunResult => {
		assert.ok(result, 'lint did not run (see before hook failure)');
		return result;
	};

	it('M1-S1-T06 lint exits non-zero with the fixtures in place', () => {
		assertExitNonZero(lintRun());
	});

	it('M1-S1-T06a `test.only` under tests/ is reported as jest/no-focused-tests (the AC NEG)', () => {
		const r = lintRun();
		assert.ok(lintReported(r.output, testsFocused, 'jest/no-focused-tests'), `jest/no-focused-tests not reported for ${testsFocused}. ${describeRun(r)}`);
	});

	it('M1-S1-T06b `test.only` inside a workspace package is reported as jest/no-focused-tests', () => {
		const r = lintRun();
		assert.ok(lintReported(r.output, packageFixture, 'jest/no-focused-tests'), `jest/no-focused-tests not reported for ${packageFixture}. ${describeRun(r)}`);
	});

	it('M1-S1-T06c `test.skip` (Jest) is reported as jest/no-disabled-tests', () => {
		const r = lintRun();
		assert.ok(lintReported(r.output, testsDisabled, 'jest/no-disabled-tests'), `jest/no-disabled-tests not reported for ${testsDisabled}. ${describeRun(r)}`);
	});

	it('M1-S1-T06d `test.skip` (Playwright) is reported as playwright/no-skipped-test', () => {
		const r = lintRun();
		assert.ok(lintReported(r.output, e2eSkipped, 'playwright/no-skipped-test'), `playwright/no-skipped-test not reported for ${e2eSkipped}. ${describeRun(r)}`);
	});

	it('M1-S1-T06e `page.waitForTimeout` is reported by a restricted-syntax/property rule', () => {
		const r = lintRun();
		const reported = ['no-restricted-syntax', 'no-restricted-properties', 'playwright/no-wait-for-timeout']
			.some(rule => lintReported(r.output, e2eSleep, rule));
		assert.ok(reported, `no rule banning waitForTimeout was reported for ${e2eSleep}. ${describeRun(r)}`);
	});
});

describe('M1-AC1 NEG: lint type-checks workspace sources (tsc --noEmit)', () => {
	let result: RunResult | undefined;
	let cleanup: (() => void) | undefined;
	let statusBefore: string | undefined;
	let fixture = '';

	before(() => {
		requireRootScript('lint');
		const target = requireWorkspaces().find(w => existsSync(join(w.dir, 'src')));
		assert.ok(target, 'no workspace package has a src/ directory to host the type-error fixture');
		fixture = `${target.rel}/src/__lint_neg__/typeError.ts`;
		statusBefore = gitStatus();
		cleanup = placeTemporarily([{ from: join(lintFixtures, 'typeError.ts.fixture'), to: join(repoRoot, fixture) }]);
		result = yarnScript(story, 'T07-lint-type-error', 'lint', [], { timeoutMs: 10 * minute });
	});

	after(() => {
		cleanup?.();
		if (statusBefore !== undefined) assert.equal(gitStatus(), statusBefore, 'type-error fixture was not cleaned up');
	});

	it('M1-S1-T07 a type error makes lint fail with TS2322 naming the file', () => {
		assert.ok(result, 'lint did not run (see before hook failure)');
		assertExitNonZero(result);
		assert.ok(lintReported(result.output, basename(fixture), 'TS2322'), `TS2322 not reported for ${fixture}. ${describeRun(result)}`);
	});
});
