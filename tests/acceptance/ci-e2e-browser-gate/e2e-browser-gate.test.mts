// CI-e2e-browser-gate (docs/test-plans/CI-e2e-browser-gate.md): run 39568721933 (x64, head 7b19554) lost its E2E result
// because `playwright install --with-deps chromium` failed on a broken preinstalled apt source of the runner
// (packages.microsoft.com, 403, "no longer signed"), and the contract layer then ran 21 min without Chromium (18 noise
// failures) because its if: did not require the browser step. Static checks of .github/workflows/e2e.yml, with each
// rule first proven on small inline workflows (positive and negative controls).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { aptFindings, gateFindings, jobsOf, topLevelConjuncts } from '../support/browserGate.mts';
import { repoRoot } from '../support/repo.mts';

const e2e = (): string => readFileSync(join(repoRoot, '.github', 'workflows', 'e2e.yml'), 'utf8');

const wf = (steps: string): string => `on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n${steps}`;
const install = (extra = '', run = 'corepack yarn playwright install --with-deps chromium'): string => `      - id: browser\n        run: ${run}\n${extra}`;
const contract = (cond: string): string => `      - id: contract\n        if: ${cond}\n        run: corepack yarn test:contract --verbose\n`;
const e2eStep = (cond: string): string => `      - id: e2e\n        if: ${cond}\n        run: corepack yarn playwright test\n`;
const guard = (cond?: string): string => `      - id: apt-sources\n${cond ? `        if: ${cond}\n` : ''}        run: sudo rm -f /etc/apt/sources.list.d/microsoft-prod.list\n`;
const ok = "${{ !cancelled() && steps.setup.outcome == 'success' && steps.browser.outcome == 'success' }}";

describe('CI-e2e-browser-gate: the checker on inline workflows', () => {
	it('CI-BG-00 topLevelConjuncts splits on top-level && and refuses a top-level ||', () => {
		assert.deepEqual(topLevelConjuncts("${{ !cancelled() && steps.browser.outcome == 'success' }}"), ['!cancelled()', "steps.browser.outcome == 'success'"]);
		assert.deepEqual(topLevelConjuncts('${{ a && (b || c) }}'), ['a', 'b || c']);
		assert.equal(topLevelConjuncts("${{ steps.browser.outcome == 'success' || always() }}"), undefined);
		assert.deepEqual(topLevelConjuncts("${{ x == 'a&&b' && y }}"), ["x == 'a&&b'", 'y']);
	});

	it('CI-BG-01 a gated contract and E2E step pass (positive control); no if: (implicit success()) passes', () => {
		assert.deepEqual(gateFindings(jobsOf(wf(install() + contract(ok) + e2eStep(ok)))), []);
		assert.deepEqual(gateFindings(jobsOf(wf(`${install()}      - id: contract\n        run: corepack yarn test:contract\n`))), []);
	});

	it('CI-BG-02 NEG: a contract step without the browser conjunct, with it under ||, or before the install is flagged', () => {
		const noGate = "${{ !cancelled() && steps.setup.outcome == 'success' }}";
		assert.equal(gateFindings(jobsOf(wf(install() + contract(noGate) + e2eStep(ok)))).length, 1);
		assert.equal(gateFindings(jobsOf(wf(install() + contract("${{ steps.browser.outcome == 'success' || always() }}")))).length, 1);
		assert.equal(gateFindings(jobsOf(wf(install() + e2eStep('${{ always() }}')))).length, 1);
		assert.equal(gateFindings(jobsOf(wf(contract(ok) + install()))).length, 1);
	});

	it('CI-BG-03 NEG: a browser install with continue-on-error, without an id, or missing is flagged', () => {
		assert.ok(gateFindings(jobsOf(wf(install('        continue-on-error: true\n') + e2eStep(ok)))).some(f => /continue-on-error/.test(f)));
		assert.ok(gateFindings(jobsOf(wf(`      - run: corepack yarn playwright install --with-deps chromium\n${e2eStep(ok)}`))).some(f => /needs an id/.test(f)));
		assert.ok(gateFindings(jobsOf(wf(e2eStep(ok)))).some(f => /exactly one/.test(f)));
	});

	it('CI-AR-01 positive controls: a guard that always runs before the install, a guard inside the install, a restricted source list, or no apt at all', () => {
		assert.deepEqual(aptFindings(jobsOf(wf(guard() + install() + e2eStep(ok)))), []);
		assert.deepEqual(aptFindings(jobsOf(wf(guard('${{ !cancelled() }}') + install() + e2eStep(ok)))), []);
		assert.deepEqual(aptFindings(jobsOf(wf(install('', "sudo sed -i 's/^/# /' /etc/apt/sources.list.d/microsoft-prod.list && corepack yarn playwright install --with-deps chromium") + e2eStep(ok)))), []);
		assert.deepEqual(aptFindings(jobsOf(wf(install('', 'sudo apt-get update -o Dir::Etc::sourceparts=/tmp/ubuntu-only && corepack yarn playwright install chromium') + e2eStep(ok)))), []);
		assert.deepEqual(aptFindings(jobsOf(wf(install('', 'corepack yarn playwright install chromium') + e2eStep(ok)))), []);
	});

	it('CI-AR-02 NEG: no guard, a retry only, a guard after the install, a conditional or masked guard, or a masked install is flagged', () => {
		assert.equal(aptFindings(jobsOf(wf(install() + e2eStep(ok)))).length, 1);
		assert.equal(aptFindings(jobsOf(wf(install('', 'for i in 1 2 3; do corepack yarn playwright install --with-deps chromium && break; done') + e2eStep(ok)))).length, 1);
		assert.equal(aptFindings(jobsOf(wf(install() + guard() + e2eStep(ok)))).length, 1);
		assert.equal(aptFindings(jobsOf(wf(guard("${{ steps.x.outcome == 'success' }}") + install() + e2eStep(ok)))).length, 1);
		assert.equal(aptFindings(jobsOf(wf(guard().replace('run:', 'continue-on-error: true\n        run:') + install() + e2eStep(ok)))).length, 1);
		assert.ok(aptFindings(jobsOf(wf(guard() + install('', 'corepack yarn playwright install --with-deps chromium || true') + e2eStep(ok)))).some(f => /fail visibly/.test(f)));
		assert.equal(aptFindings(jobsOf(wf(install('', 'ls /etc/apt/sources.list.d && corepack yarn playwright install --with-deps chromium') + e2eStep(ok)))).length, 1);
	});
});

describe('CI-e2e-browser-gate: .github/workflows/e2e.yml', () => {
	it('CI-BG-10 every e2e.yml step that needs Playwright\'s browser (contract and E2E layers) requires the browser install\'s success', () => {
		const jobs = jobsOf(e2e());
		assert.ok(jobs.some(j => j.steps.some(s => /\btest:contract\b/.test(s.run ?? ''))), 'e2e.yml has a contract-layer step');
		assert.ok(jobs.some(j => j.steps.some(s => /\bplaywright\s+test\b/.test(s.run ?? ''))), 'e2e.yml has an E2E-layer step');
		assert.deepEqual(gateFindings(jobs), []);
	});

	it('CI-AR-10 the browser install in e2e.yml cannot be failed by a broken, unrelated third-party apt source of the runner', () => {
		assert.deepEqual(aptFindings(jobsOf(e2e())), []);
	});
});
