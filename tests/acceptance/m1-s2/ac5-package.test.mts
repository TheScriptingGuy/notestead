// M1-AC5 (packaging step, fast): `corepack yarn workspace web-build package <dist> --out <dir> [--pin <file>]` turns a
// dist/ into web-bundle-<web.tag>.tar.zst + SHA256SUMS + bundle-manifest.json, the outputs M1-AC5 requires of
// `build`. `package` is the test seam described in docs/test-plans/M1-S2.md (build = recipe → overlay → verify →
// package). The full `build` runs in tests/acceptance/m1-s2/optin/ac5-build.optin.mts (CI x64; Pi on request).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertExitNonZero, assertExitZero, assertOutputIncludes, makeTempDir, readPin, removeDir } from '../support/repo.mts';
import type { Pin, RunResult } from '../support/repo.mts';
import { artifactName, assertArtifact, attempt, materialize, settled, syntheticBundle, webBuild } from '../support/webBundle.mts';
import type { Attempt, Tree } from '../support/webBundle.mts';

describe('M1-AC5 package: tar.zst + SHA256SUMS + bundle-manifest.json (fixture F1)', () => {
	const temps: string[] = [];
	let input: Tree = new Map();
	let dist = '';
	let out = '';
	let setup: Attempt<RunResult> | null = null;

	before(() => {
		input = syntheticBundle();
		dist = materialize('m1s2-ac5-dist', input);
		const work = makeTempDir('m1s2-ac5-out');
		temps.push(dist, work);
		out = join(work, 'out');
		setup = attempt(() => webBuild('T80-package-F1', 'package', [dist, '--out', out]));
	});

	after(() => temps.forEach(removeDir));

	it('T80 package exits 0; the artifact holds exactly the dist; SHA256SUMS and bundle-manifest.json are correct', () => {
		assertExitZero(settled(setup));
		const extractInto = makeTempDir('m1s2-ac5-extract');
		temps.push(extractInto);
		assertArtifact('T80', out, readPin(), extractInto, input);
	});

	it('T81 the artifact name and upstream fields come from the pin (--pin with another tag)', () => {
		const pin: Pin = { ...readPin() };
		pin.web = { ...pin.web, tag: `${pin.web.tag}-m1s2fixture` };
		const work = makeTempDir('m1s2-ac5-pin');
		temps.push(work);
		const pinFile = join(work, 'joplin-version.json');
		writeFileSync(pinFile, `${JSON.stringify(pin, null, '\t')}\n`);
		const pinOut = join(work, 'out');
		const r = webBuild('T81-package-F1-other-pin', 'package', [dist, '--out', pinOut, '--pin', pinFile]);
		assertExitZero(r);
		const extractInto = join(work, 'extract');
		mkdirSync(extractInto);
		const { manifest } = assertArtifact('T81', pinOut, pin, extractInto, input);
		assert.equal(manifest.upstream?.tag, pin.web.tag);
		assert.ok(existsSync(join(pinOut, artifactName(pin))), `expected ${artifactName(pin)}`);
	});

	it('T82 NEG: packaging a missing dist fails, names it and writes no tarball', () => {
		const work = makeTempDir('m1s2-ac5-missing');
		temps.push(work);
		const missing = join(work, 'no-such-dist');
		const missingOut = join(work, 'out');
		const r = webBuild('T82-package-missing-dist', 'package', [missing, '--out', missingOut]);
		assertExitNonZero(r);
		assertOutputIncludes(r, missing, 'package must name the missing dist');
		const written = existsSync(missingOut) ? readdirSync(missingOut) : [];
		assert.ok(!written.some(n => n.endsWith('.tar.zst')), `no tarball may be written, found ${JSON.stringify(written)}`);
	});
});
