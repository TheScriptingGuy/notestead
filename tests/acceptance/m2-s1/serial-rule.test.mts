// ADR-0007 A3 (docs/test-plans/M2-S1.md §Disruptive tests): a spec that stops, restarts or reconfigures a shared
// service of the run's stack is named *.serial.spec.ts and runs in the `chromium-serial` project, alone. Static checks:
// the projects, the config's use of them, the scanner on a disruptive and a read-only fixture, and the repo's E2E specs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../support/repo.mts';
import { disruptiveLines } from '../support/serialRule.mts';

const fixtures = join(repoRoot, 'tests', 'fixtures', 'm2-s1', 'serial');

const specsUnder = (dir: string): string[] => readdirSync(dir).flatMap(name => {
	const path = join(dir, name);
	return statSync(path).isDirectory() ? specsUnder(path) : path.endsWith('.spec.ts') ? [path] : [];
});

describe('M2-S1 serial rule (ADR-0007 A3)', () => {
	it('M2-S1-SER-01 the parallel project ignores *.serial.spec.ts and the serial project runs them alone', async () => {
		const { e2eProjects } = await import('../../e2e/support/projects.ts');
		assert.deepEqual(e2eProjects({}), [
			{ name: 'chromium', use: {}, testIgnore: '**/*.serial.spec.ts' },
			{ name: 'chromium-serial', use: {}, testMatch: '**/*.serial.spec.ts', workers: 1, fullyParallel: false, dependencies: ['chromium'] },
		]);
	});

	it('M2-S1-SER-02 playwright.config.ts uses e2eProjects', () => {
		const config = readFileSync(join(repoRoot, 'playwright.config.ts'), 'utf8');
		assert.match(config, /projects:\s*e2eProjects\(devices\['Desktop Chrome'\]\)/);
	});

	it('M2-S1-SER-03 the scanner flags every disruptive form and no read-only one', () => {
		const disruptive = readFileSync(join(fixtures, 'disruptive.spec.ts.fixture'), 'utf8');
		const marked = disruptive.split('\n').flatMap((line, i) => (line.includes('// NEG') ? [i + 1] : []));
		assert.equal(marked.length, 6, 'the fixture has six marked lines');
		assert.deepEqual(disruptiveLines(disruptive), marked);
		assert.deepEqual(disruptiveLines(readFileSync(join(fixtures, 'readonly.spec.ts.fixture'), 'utf8')), []);
	});

	it('M2-S1-SER-04 every disruptive E2E spec is a serial spec', () => {
		const specs = specsUnder(join(repoRoot, 'tests', 'e2e'));
		assert.ok(specs.length >= 3, `scanned ${specs.length} spec files, expected at least 3`);
		const offenders = specs.filter(f => !f.endsWith('.serial.spec.ts')).flatMap(f => disruptiveLines(readFileSync(f, 'utf8')).map(n => `${relative(repoRoot, f)}:${n}`));
		assert.deepEqual(offenders, []);
	});
});
