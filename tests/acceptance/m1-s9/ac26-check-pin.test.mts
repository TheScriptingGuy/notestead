// M1-AC26: `corepack yarn check:pin [--pin <file>] [--lockfile <file>] [--headless-manifest <file>]` also checks
// (a) that packages/headless/package.json depends on `joplin` at exactly cli.version, and (b) that the lockfile
// `resolution:` of `joplin` and of every `@joplin/*` entry is the npm registry form `<name>@npm:<version>`.
// Lockfile NEG fixtures are generated at test time from the M1-S1 valid lockfile by replacing exactly one
// `resolution:` line (asserted), so each case differs from the valid fixture in one place only.
// Test plan: docs/test-plans/M1-S9.md.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, describeRun, ensureInstalled, fixturesDir, makeTempDir, removeDir, yarnScript,
} from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';

const story = 'm1-s9';
const minute = 60_000;
const contract = 'docs/test-plans/M1-S9.md §Command contracts';
const validPin = join(fixturesDir, 'm1-s1', 'pin', 'valid.json');
const validLock = join(fixturesDir, 'm1-s1', 'lockfile', 'valid.yarn.lock');
const fakeSha = '0123456789abcdef0123456789abcdef01234567';

let installed = false;
const checkPin = (label: string, args: string[]): RunResult => {
	if (!installed) {
		ensureInstalled(story);
		installed = true;
	}
	return yarnScript(story, label, 'check:pin', args, { timeoutMs: 3 * minute }, contract);
};

const temps: string[] = [];
after(() => temps.forEach(removeDir));
const tempDir = (prefix: string): string => {
	const dir = makeTempDir(`m1s9-${prefix}`);
	temps.push(dir);
	return dir;
};

const lineWith = (r: RunResult, needles: (string | RegExp)[]): boolean =>
	r.output.split('\n').some(line => needles.every(n => typeof n === 'string' ? line.includes(n) : n.test(line)));
const assertLine = (r: RunResult, needles: (string | RegExp)[], why: string): void => {
	assert.ok(lineWith(r, needles), `${why}: expected one output line containing all of ${needles.map(String).join(' , ')}. ${describeRun(r)}`);
};

const headlessManifest = (dir: string, file: string, dependencies: Record<string, string>): string => {
	const path = join(dir, file);
	writeFileSync(path, `${JSON.stringify({ name: 'headless', version: '0.0.0', private: true, license: 'AGPL-3.0-or-later', type: 'module', dependencies }, null, 2)}\n`);
	return path;
};

describe('M1-AC26 (a) packages/headless/package.json pins `joplin` to exactly cli.version', () => {
	it('M1-S9-T300 positive control: `"joplin": "3.7.1"` (= cli.version of the valid pin) passes', () => {
		const dir = tempDir('manifest-ok');
		const r = checkPin('T300-manifest-exact', ['--pin', validPin, '--lockfile', validLock, '--headless-manifest', headlessManifest(dir, 'headless-exact.package.json', { joplin: '3.7.1' })]);
		assertExitZero(r);
	});

	const cases: { id: string; file: string; deps: Record<string, string>; why: string }[] = [
		{ id: 'T301', file: 'headless-caret.package.json', deps: { joplin: '^3.7.1' }, why: '(AC NEG) a caret range fails' },
		{ id: 'T302', file: 'headless-3.7.0.package.json', deps: { joplin: '3.7.0' }, why: '(AC NEG) another exact version fails' },
		{ id: 'T303', file: 'headless-tilde.package.json', deps: { joplin: '~3.7.1' }, why: 'a tilde range fails' },
		{ id: 'T304', file: 'headless-missing.package.json', deps: { lodash: '4.17.21' }, why: 'no `joplin` dependency fails' },
	];
	for (const c of cases) {
		it(`M1-S9-${c.id} NEG: ${c.why}, naming the manifest and the field`, () => {
			const dir = tempDir(c.id);
			const r = checkPin(`${c.id}-manifest`, ['--pin', validPin, '--lockfile', validLock, '--headless-manifest', headlessManifest(dir, c.file, c.deps)]);
			assertExitNonZero(r);
			assertLine(r, [c.file, 'dependencies.joplin'], 'the message names the manifest and the field');
		});
	}
});

describe('M1-AC26 (b) lockfile resolutions of joplin and @joplin/* are npm registry resolutions', () => {
	const validText = readFileSync(validLock, 'utf8');

	// A copy of the valid lockfile with exactly one `resolution:` line replaced.
	const lockWith = (id: string, from: string, to: string): string => {
		const fromLine = `  resolution: "${from}"`;
		const occurrences = validText.split('\n').filter(l => l === fromLine).length;
		assert.equal(occurrences, 1, `fixture sanity: ${fromLine} occurs exactly once in ${validLock}`);
		const path = join(tempDir(id), `${id}.yarn.lock`);
		writeFileSync(path, validText.replace(fromLine, `  resolution: "${to}"`));
		return path;
	};

	const run = (id: string, lock: string): RunResult => checkPin(`${id}-lockfile`, ['--pin', validPin, '--lockfile', lock]);

	const negatives: { id: string; why: string; from: string; to: string; name: string; protocol: RegExp }[] = [
		{ id: 'T310', why: '(AC NEG 1) @joplin/lib from a git fork over https (version still 3.7.1)', from: '@joplin/lib@npm:3.7.1', to: `@joplin/lib@https://github.com/someone/joplin-fork.git#commit=${fakeSha}`, name: '@joplin/lib', protocol: /https|git/ },
		{ id: 'T311', why: '(AC NEG 2) joplin from a local patch', from: 'joplin@npm:3.7.1', to: 'joplin@patch:joplin@npm%3A3.7.1#~/local-hack.patch::version=3.7.1&hash=0a1b2c&locator=headless%40workspace%3Apackages%2Fheadless', name: 'joplin', protocol: /patch/ },
		{ id: 'T312', why: '(AC NEG 3) an @joplin/* package from file:', from: '@joplin/utils@npm:3.7.1', to: '@joplin/utils@file:../joplin-utils::locator=headless%40workspace%3Apackages%2Fheadless', name: '@joplin/utils', protocol: /file/ },
		{ id: 'T313', why: '(AC NEG 3) an @joplin/* package from link:', from: '@joplin/renderer@npm:3.7.1', to: '@joplin/renderer@link:../renderer::locator=headless%40workspace%3Apackages%2Fheadless', name: '@joplin/renderer', protocol: /link/ },
		{ id: 'T314', why: 'an @joplin/* package from git+ssh', from: '@joplin/htmlpack@npm:3.7.1', to: `@joplin/htmlpack@git+ssh://git@github.com/someone/htmlpack.git#commit=${fakeSha}`, name: '@joplin/htmlpack', protocol: /git/ },
		{ id: 'T315', why: 'an exempt fork (@joplin/fork-*) from github: is still rejected', from: '@joplin/fork-sax@npm:1.2.68', to: `@joplin/fork-sax@github:someone/fork-sax#commit=${fakeSha}`, name: '@joplin/fork-sax', protocol: /github/ },
		{ id: 'T316', why: 'an @joplin/* package from an https tarball', from: '@joplin/turndown@npm:4.0.86', to: '@joplin/turndown@https://example.com/joplin-turndown-4.0.86.tgz', name: '@joplin/turndown', protocol: /https/ },
		{ id: 'T317', why: 'an @joplin/* package from portal:', from: '@joplin/onenote-converter@npm:3.7.1', to: '@joplin/onenote-converter@portal:../onenote::locator=headless%40workspace%3Apackages%2Fheadless', name: '@joplin/onenote-converter', protocol: /portal/ },
		{ id: 'T318', why: 'an @joplin/* package from exec:', from: '@joplin/turndown-plugin-gfm@npm:1.0.68', to: '@joplin/turndown-plugin-gfm@exec:./generate.js::locator=headless%40workspace%3Apackages%2Fheadless', name: '@joplin/turndown-plugin-gfm', protocol: /exec/ },
	];
	for (const c of negatives) {
		it(`M1-S9-${c.id} NEG: ${c.why} fails, naming the entry and its protocol`, () => {
			const r = run(c.id, lockWith(c.id, c.from, c.to));
			assertExitNonZero(r);
			assertLine(r, [c.name, c.protocol], 'the message names the entry and its protocol');
		});
	}

	it('M1-S9-T319 positive control: non-joplin entries may use patch:/git (yarn builtin patches, a `joplin-` named decoy) and still pass', () => {
		const dir = tempDir('decoys');
		const text = validText
			.replace('  resolution: "lodash@npm:4.17.21"', '  resolution: "lodash@patch:lodash@npm%3A4.17.21#optional!builtin<compat/lodash>::version=4.17.21&hash=5786d5"')
			.replace('  resolution: "joplin-turndown-plugin-gfm@npm:1.0.12"', `  resolution: "joplin-turndown-plugin-gfm@https://github.com/someone/plugin.git#commit=${fakeSha}"`);
		assert.equal(text.split('\n').filter((l, i) => l !== validText.split('\n')[i]).length, 2, 'fixture sanity: exactly two decoy resolutions changed');
		const path = join(dir, 'decoys.yarn.lock');
		writeFileSync(path, text);
		assertExitZero(run('T319', path));
	});
});
