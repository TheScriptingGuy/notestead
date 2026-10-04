import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { distFixture, publicFiles, removeTempDirs, upstreamRepo, webBuildDir, writeFiles } from './testing/fixtures.ts';
import { sha256 } from './tree.ts';
import { upstreamFile, upstreamIconHashes, upstreamPublicDir, verifyBundle } from './verify.ts';

const overlayEnvironment = (): Buffer => readFileSync(join(webBuildDir, 'overlay', 'environment.js'));

describe('verify', () => {
	afterAll(removeTempDirs);

	test('derives the icon hashes from the upstream tree and fails when there are none', () => {
		const upstream = upstreamRepo();
		const hashes = upstreamIconHashes(upstream.dir, upstream.commit);
		expect([...hashes.values()].sort()).toEqual([`${upstreamPublicDir}/icons/icon-64.png`, `${upstreamPublicDir}/icons/icon-vector-large.svg`]);
		expect(hashes.get(sha256(publicFiles()['icons/icon-64.png']))).toBe(`${upstreamPublicDir}/icons/icon-64.png`);
		expect(() => upstreamIconHashes(webBuildDir, 'HEAD')).toThrow('has no files; the icon check cannot run');
	});

	test('passes a clean bundle and names every upstream icon copy, the environment and the CSP', () => {
		const upstream = upstreamRepo();
		const input = (dist: string) => ({
			dist,
			iconHashes: upstreamIconHashes(upstream.dir, upstream.commit),
			overlayEnvironment: overlayEnvironment(),
			upstreamIndexHtml: upstreamFile(upstream.dir, upstream.commit, `${upstreamPublicDir}/index.html`).toString('utf8'),
		});

		const clean = distFixture();
		writeFiles(clean, { 'environment.js': overlayEnvironment(), 'icons/icon-64.png': 'ours', 'icons/icon-vector-large.svg': '<svg>ours</svg>' });
		expect(verifyBundle(input(clean))).toEqual([]);

		const dirty = distFixture();
		writeFiles(dirty, { 'deep/er/copy.bin': publicFiles()['icons/icon-64.png'] });
		writeFiles(dirty, { 'index.html': publicFiles()['index.html'].replace("default-src 'self' ;", "default-src 'self' https://x ;") });
		expect(verifyBundle(input(dirty))).toEqual([
			expect.stringMatching(/^deep\/er\/copy\.bin is byte-identical to the upstream icon upstream:.*icons\/icon-64\.png/),
			expect.stringMatching(/^icons\/icon-64\.png is byte-identical/),
			expect.stringMatching(/^icons\/icon-vector-large\.svg is byte-identical/),
			expect.stringMatching(/^environment\.js is not the overlay's/),
			expect.stringMatching(/^index\.html: the Content-Security-Policy <meta> differs/),
		]);
	});
});
