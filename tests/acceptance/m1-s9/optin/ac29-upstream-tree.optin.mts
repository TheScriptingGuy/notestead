// M1-AC29 integration on a real upstream install (opt-in, local): runs the notices seam over an upstream checkout at
// web.commit after the recipe's `yarn install` and its built dist (default: the spike S1 tree), checks the notices
// against the test's own closure walk, then overlay → verify on a copy of the dist with the generated file.
// Not matched by the default `*.test.mts` glob; run by name:
//   node --test --test-reporter=spec tests/acceptance/m1-s9/optin/ac29-upstream-tree.optin.mts
//   NOTESTEAD_UPSTREAM_TREE=<checkout> (default ~/joplin-web-app-work/spikes/S1/joplin); the dist is
//   <checkout>/packages/app-mobile/web/dist. CI covers the same path inside T90 (tests/acceptance/m1-s2/optin).
// Test plan: docs/test-plans/M1-S9.md.
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
	assertExitZero, describeRun, ensureInstalled, git, makeTempDir, readPin, removeDir, repoRoot, yarn,
} from '../../support/repo.mts';
import type { RunResult } from '../../support/repo.mts';
import { noticesCoverage } from '../../support/licenses.mts';
import { requireWorkspaceScript } from '../../support/webBundle.mts';

const story = 'm1-s9';
const minute = 60_000;
const noticesName = 'third-party-notices.txt';
const tree = process.env.NOTESTEAD_UPSTREAM_TREE ?? join(homedir(), 'joplin-web-app-work', 'spikes', 'S1', 'joplin');
const realDist = join(tree, 'packages', 'app-mobile', 'web', 'dist');
const defaultExceptions = join(repoRoot, 'packages', 'web-build', 'license-exceptions.json');

const webBuild = (label: string, script: string, args: string[]): RunResult => {
	ensureInstalled(story);
	requireWorkspaceScript(script, 'docs/test-plans/M1-S9.md §Command contracts');
	return yarn(story, label, ['workspace', 'web-build', script, ...args], { timeoutMs: 20 * minute });
};

describe('M1-AC29 notices on a real upstream install (opt-in, local)', () => {
	const temps: string[] = [];
	after(() => temps.forEach(removeDir));
	const base = makeTempDir('m1s9-upstream-tree');
	temps.push(base);
	const out = join(base, noticesName);

	it('M1-S9-T490 the notices seam covers the app-mobile closure and the banner packages of the real tree, with full licence texts', { timeout: 30 * minute }, () => {
		assert.ok(existsSync(join(tree, 'yarn.lock')) && existsSync(join(tree, 'node_modules')) && existsSync(join(realDist, 'index.html')),
			`no installed and built upstream tree at ${tree}; set NOTESTEAD_UPSTREAM_TREE to an upstream checkout after \`yarn install\` and \`yarn web\``);
		assert.equal(git(tree, ['rev-parse', 'HEAD']).trim(), readPin().web.commit, `${tree} must be checked out at the pinned web.commit`);
		const r = webBuild('T490-notices-upstream', 'notices', [tree, '--bundle', realDist, '--out', out]);
		assertExitZero(r);
		const coverage = noticesCoverage(readFileSync(out, 'utf8'), tree, realDist, defaultExceptions);
		assert.ok(coverage.closureSize > 1000, `fixture sanity: the app-mobile closure has ${coverage.closureSize} packages`);
		assert.ok(coverage.bannerPackages.includes('react-dom'), 'fixture sanity: the react-dom banner (a package outside the dependencies closure) is present at web.commit');
		assert.deepEqual(coverage.problems.slice(0, 50), [], `${coverage.problems.length} coverage problem(s) in ${out} (first 50 shown; not installed and so not required: ${coverage.notInstalled.join(', ')}). ${describeRun(r)}`);
	});

	it('M1-S9-T491 a copy of the real dist with the generated notices: overlay links them and verify passes', { timeout: 30 * minute }, () => {
		assert.ok(existsSync(out), 'T490 must have produced the notices first');
		const dist = join(base, 'dist');
		cpSync(realDist, dist, { recursive: true });
		writeFileSync(join(dist, noticesName), readFileSync(out));
		assertExitZero(webBuild('T491-overlay', 'overlay', [dist]));
		const source = readFileSync(join(dist, 'source.html'), 'utf8');
		assert.match(source, /href\s*=\s*["'](?:\.\/)?third-party-notices\.txt["']/, 'source.html links the notices');
		for (const extract of ['app.bundle.js.LICENSE.txt', 'serviceWorker.bundle.js.LICENSE.txt']) {
			assert.ok(source.includes(extract), `source.html still links ${extract}`);
		}
		assertExitZero(webBuild('T491-verify', 'verify', [dist]));
	});
});
