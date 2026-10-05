// M1-AC28: `corepack yarn workspace web-build import <artifact-dir> --out <dist> [--pin <file>] [--upstream <git-dir>]`
// installs a packaged bundle (CI-built, or written by `package`) as the dist/ the web image is built from.
// - Before extracting anything: SHA256SUMS verifies the tarball and bundle-manifest.json; upstream.{repo,tag,commit}
//   equals the pin; every tar entry is a regular file or directory, relative, without `..`, and listed in `files`.
// - After extracting: each file's sha256 equals its `files` entry, nothing outside `files` exists, `verify` passes.
// - Every failure names the reason and leaves --out absent or empty (and writes nothing outside it).
// The image half of M1-AC28 (the image built from the imported dist passes M1-AC12) is in tests/contract/m1-s4/.
// Test plan: docs/test-plans/M1-S4.md.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertExitNonZero, assertExitZero, describeRun, makeTempDir, readPin, removeDir, run } from '../support/repo.mts';
import type { Pin, RunResult } from '../support/repo.mts';
import { sha256 } from '../support/upstream.mts';
import { artifactName, attempt, materialize, readTree, settled, upstreamPublicBundle } from '../support/webBundle.mts';
import type { Attempt, Tree } from '../support/webBundle.mts';
import {
	absentOrEmpty, copyArtifact, describeDir, manifestFiles, noticesName, overlaidServable, readManifest, resum, runImport,
	story, treeEntries, upstreamArgs, webBuild, writeHandmadeArtifact, writeManifest,
} from '../support/webImport.mts';
import type { ManifestFile, TarEntry } from '../support/webImport.mts';

interface Fixture {
	// F3 overlaid (passes verify) and the artifact `package` wrote for it.
	tree: Tree;
	artifact: string;
}

const temps: string[] = [];
after(() => temps.forEach(removeDir));
const tempDir = (prefix: string): string => {
	const dir = makeTempDir(`m1s4-${prefix}`);
	temps.push(dir);
	return dir;
};

// Every NEG: non-zero exit (not a kill), the reason named, --out absent or empty.
const assertRefused = (r: RunResult, out: string, reason: RegExp[], why: string): void => {
	assertExitNonZero(r);
	for (const pattern of reason) assert.match(r.output, pattern, `${why}: the error must name the reason (${pattern}). ${describeRun(r)}`);
	assert.ok(absentOrEmpty(out), `${why}: --out must be absent or empty after a refused import, found ${describeDir(out)}`);
};

describe('M1-AC28 web-build import (fixture F3: overlaid upstream public files + synthetic webpack outputs)', () => {
	let setup: Attempt<Fixture> | null = null;
	const pin: Pin = readPin();
	const tarName = artifactName(pin);

	before(() => {
		setup = attempt(() => {
			const { dir, tree } = overlaidServable('I00', 'm1s4-f3');
			temps.push(dir);
			const artifact = join(tempDir('artifact'), 'artifact');
			const r = webBuild('I00-package-F3', 'package', [dir, '--out', artifact]);
			assertExitZero(r);
			return { tree, artifact };
		});
	});

	const fixture = (): Fixture => settled(setup);

	// A fresh copy of the packaged artifact, edited by `edit`.
	const variant = (label: string, edit: (dir: string) => void): string => {
		const dir = copyArtifact(fixture().artifact, join(tempDir(label), 'artifact'));
		edit(dir);
		return dir;
	};

	// A hand-written artifact: F3's files (regular entries) plus `extra` entries; `listed` adds manifest entries.
	const handmade = (label: string, extra: TarEntry[], listedExtra: ManifestFile[], { extraFirst = false } = {}): string => {
		const base = treeEntries(fixture().tree);
		const entries = extraFirst ? [...extra, ...base] : [...base, ...extra];
		return writeHandmadeArtifact(join(tempDir(label), 'artifact'), entries, [...manifestFiles(fixture().tree), ...listedExtra]
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
	};

	const outDir = (label: string): string => join(tempDir(`${label}-out`), 'dist');

	it('I00 harness: the hand-written ustar fixtures are valid tars with exactly the intended entry names and types', () => {
		const dir = handmade('i00', [
			{ name: 'alias.html', type: 'symlink', linkname: 'index.html' },
			{ name: '../escape.txt', type: 'file', content: Buffer.from('escape\n') },
		], []);
		const listing = run(story, 'I00-tar-tvf', 'tar', ['--zstd', '-tvf', join(dir, tarName)]);
		assertExitZero(listing);
		const lines = listing.stdout.split('\n').filter(l => l !== '');
		assert.equal(lines.length, fixture().tree.size + 2, 'one tar entry per F3 file plus the two hostile entries');
		assert.ok(lines.some(l => l.startsWith('l') && l.includes('alias.html -> index.html')), `a symlink entry alias.html -> index.html: ${lines.slice(-2).join(' | ')}`);
		assert.ok(lines.some(l => l.startsWith('-') && l.endsWith(' ../escape.txt')), `a regular entry named ../escape.txt: ${lines.slice(-2).join(' | ')}`);
		assertExitZero(run(story, 'I00-sha256sum-check', 'sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir }));
	});

	it('I01 import of a `package` artifact installs exactly the bundle; every sha256 matches; verify passes on --out', () => {
		const out = outDir('i01');
		const r = runImport('I01-import-F3', fixture().artifact, out);
		assertExitZero(r);
		const installed = readTree(out);
		const expected = fixture().tree;
		assert.deepEqual([...installed.keys()].sort(), [...expected.keys()].sort(), '--out must hold exactly the files listed in bundle-manifest.json');
		for (const [path, content] of expected) assert.ok(installed.get(path)?.equals(content), `${path} differs from the packaged bundle`);
		for (const file of readManifest(fixture().artifact).files ?? []) {
			assert.equal(sha256(installed.get(file.path) ?? Buffer.alloc(0)), file.sha256, `sha256 of ${file.path} vs bundle-manifest.json`);
		}
		assertExitZero(webBuild('I01-verify-out', 'verify', [...upstreamArgs(), out]));
	});

	it('I02 positive control for the NEG fixtures: a hand-written ustar artifact of the same bundle imports', () => {
		const out = outDir('i02');
		assertExitZero(runImport('I02-import-handmade', handmade('i02', [], []), out));
		assert.equal(readTree(out).size, fixture().tree.size, 'the hand-written artifact installs every F3 file');
	});

	it('I03 a non-empty --out is refused, named and left unchanged', () => {
		const out = outDir('i03');
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, 'keep.txt'), 'pre-existing\n');
		const r = runImport('I03-import-nonempty-out', fixture().artifact, out);
		assertExitNonZero(r);
		assert.ok(r.output.includes(out), `import must name the non-empty --out. ${describeRun(r)}`);
		assert.deepEqual([...readTree(out).keys()], ['keep.txt'], 'the existing --out must be left unchanged');
		assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'pre-existing\n');
	});

	it('I10 (AC NEG) a tampered tarball (SHA256SUMS mismatch) is refused before extraction', () => {
		const art = variant('i10', dir => {
			const tar = readFileSync(join(dir, tarName));
			tar[Math.floor(tar.length / 2)] ^= 0xff;
			writeFileSync(join(dir, tarName), tar);
		});
		const out = outDir('i10');
		assertRefused(runImport('I10-import-tampered-tarball', art, out), out, [new RegExp(tarName.replace(/\./g, '\\.')), /SHA256SUMS|checksum|sha256/i], 'tampered tarball');
	});

	it('I11 NEG: a tampered bundle-manifest.json (SHA256SUMS mismatch) is refused', () => {
		const art = variant('i11', dir => {
			const manifest = readManifest(dir);
			manifest.files = (manifest.files ?? []).filter(f => f.path !== 'index.css');
			writeManifest(dir, manifest);
		});
		const out = outDir('i11');
		assertRefused(runImport('I11-import-tampered-manifest', art, out), out, [/bundle-manifest\.json/, /SHA256SUMS|checksum|sha256/i], 'tampered manifest');
	});

	it('I12 NEG: a SHA256SUMS without a line for the tarball is refused (fails closed)', () => {
		const art = variant('i12', dir => {
			const lines = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(l => l !== '' && !l.endsWith(tarName));
			writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
		});
		const out = outDir('i12');
		assertRefused(runImport('I12-import-sums-without-tarball', art, out), out, [new RegExp(tarName.replace(/\./g, '\\.')), /SHA256SUMS/], 'SHA256SUMS without the tarball');
	});

	it('I13 (AC NEG) a manifest whose upstream.commit differs from the pin is refused (checksums consistent)', () => {
		const otherCommit = 'f'.repeat(40);
		const art = variant('i13', dir => {
			const manifest = readManifest(dir);
			manifest.upstream = { ...manifest.upstream, commit: otherCommit };
			writeManifest(dir, manifest);
			resum(dir);
		});
		const out = outDir('i13');
		assertRefused(runImport('I13-import-wrong-commit', art, out), out, [/commit/, new RegExp(otherCommit)], 'upstream.commit ≠ pin');
	});

	it('I14 NEG: a manifest whose upstream.repo differs from the pin is refused (checksums consistent)', () => {
		const otherRepo = 'https://github.com/someone/joplin-fork.git';
		const art = variant('i14', dir => {
			const manifest = readManifest(dir);
			manifest.upstream = { ...manifest.upstream, repo: otherRepo };
			writeManifest(dir, manifest);
			resum(dir);
		});
		const out = outDir('i14');
		assertRefused(runImport('I14-import-wrong-repo', art, out), out, [/repo/, /someone\/joplin-fork/], 'upstream.repo ≠ pin');
	});

	it('I15 (AC NEG) a tar entry not listed in `files` is refused before extraction (entry placed last)', () => {
		const art = handmade('i15', [{ name: 'unlisted-extra.js', type: 'file', content: Buffer.from('/* not in the manifest */\n') }], []);
		const out = outDir('i15');
		assertRefused(runImport('I15-import-unlisted-entry', art, out), out, [/unlisted-extra\.js/], 'unlisted tar entry');
	});

	it('I16 (AC NEG) a symlink tar entry is refused even when it is listed with its target\'s hash', () => {
		const index = fixture().tree.get('index.html') ?? Buffer.alloc(0);
		const art = handmade('i16', [{ name: 'alias.html', type: 'symlink', linkname: 'index.html' }],
			[{ path: 'alias.html', sha256: sha256(index), size: index.length }]);
		const out = outDir('i16');
		assertRefused(runImport('I16-import-symlink', art, out), out, [/alias\.html/, /symlink|symbolic|link|not a regular file/i], 'symlink entry');
	});

	it('I17 (AC NEG) a tar entry whose path contains `..` is refused and nothing is written outside --out', () => {
		const content = Buffer.from('escaped\n');
		const base = tempDir('i17-out');
		const out = join(base, 'dist');
		const art = handmade('i17', [{ name: '../m1s4-escape.txt', type: 'file', content }],
			[{ path: '../m1s4-escape.txt', sha256: sha256(content), size: content.length }]);
		assertRefused(runImport('I17-import-dotdot', art, out), out, [/m1s4-escape\.txt/, /\.\./], '`..` entry');
		assert.ok(!existsSync(join(base, 'm1s4-escape.txt')), 'the `..` entry must not be written next to --out');
	});

	it('I18 NEG: an absolute tar entry path is refused and nothing is written there', () => {
		const target = join(tempDir('i18-abs'), 'm1s4-absolute.txt');
		const content = Buffer.from('absolute\n');
		const art = handmade('i18', [{ name: target, type: 'file', content }], [{ path: target, sha256: sha256(content), size: content.length }], { extraFirst: true });
		const out = outDir('i18');
		assertRefused(runImport('I18-import-absolute', art, out), out, [/m1s4-absolute\.txt/], 'absolute entry');
		assert.ok(!existsSync(target), `the absolute entry must not be written to ${target}`);
	});

	it('I19 NEG: a file whose content does not match its `files` sha256 is refused after extraction, leaving --out empty', () => {
		const art = variant('i19', dir => {
			const manifest = readManifest(dir);
			manifest.files = (manifest.files ?? []).map(f => (f.path === 'index.html' ? { ...f, sha256: '0'.repeat(64) } : f));
			writeManifest(dir, manifest);
			resum(dir);
		});
		const out = outDir('i19');
		assertRefused(runImport('I19-import-sha-mismatch', art, out), out, [/index\.html/], 'per-file sha256 mismatch');
	});

	it('I20 NEG: a file listed in `files` but missing from the tarball is refused, leaving --out empty', () => {
		const ghost = Buffer.from('listed but absent\n');
		const art = handmade('i20', [], [{ path: 'listed-but-missing.js', sha256: sha256(ghost), size: ghost.length }]);
		const out = outDir('i20');
		assertRefused(runImport('I20-import-listed-missing', art, out), out, [/listed-but-missing\.js/], 'listed file missing');
	});

	it('I21 NEG: a consistent artifact of an un-overlaid bundle fails import\'s verify step, leaving --out empty', () => {
		const tree = upstreamPublicBundle();
		tree.set(noticesName, Buffer.from('Third-party notices (M1-S4 fixture placeholder)\n'));
		const dist = materialize('m1s4-i21-unoverlaid', tree);
		temps.push(dist);
		const art = join(tempDir('i21'), 'artifact');
		assertExitZero(webBuild('I21-package-unoverlaid', 'package', [dist, '--out', art]));
		const out = outDir('i21');
		assertRefused(runImport('I21-import-unoverlaid', art, out), out, [/icons\/icon-[^\s]*\.png|environment\.js/], 'verify fails on the imported bundle');
	});
});
