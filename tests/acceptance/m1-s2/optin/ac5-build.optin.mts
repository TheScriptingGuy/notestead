// M1-AC5 (full build, opt-in): `corepack yarn workspace web-build build --out <dir> --work <dir>` clones web.repo at
// web.commit, runs the upstream recipe (`corepack yarn install` with SKIP_ONENOTE_CONVERTER_BUILD=1, then
// `cd packages/app-mobile && yarn web`), applies the overlay, verifies and packages web-bundle-<web.tag>.tar.zst +
// SHA256SUMS + bundle-manifest.json.
//
// Heavy: ~43 min and ~7 GiB peak on the Pi (spike S1), ~13 GB of disk under --work. The file name does not match
// the default acceptance glob (`*.test.mts`), so it only runs when named explicitly:
//   node --test --test-reporter=spec tests/acceptance/m1-s2/optin/ac5-build.optin.mts
// CI runs it on x64 (M1-S3 web-bundle.yml). On arm64 it also requires NOTESTEAD_ALLOW_ARM64_WEB_BUILD=1 (an interlock
// against starting a 43-minute, swap-filling job by accident; resource rules in CLAUDE.md).
// Optional: NOTESTEAD_BUILD_WORK=<dir> puts the upstream checkout on a disk with room (default: a temp dir).
// Test plan: docs/test-plans/M1-S2.md.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertExitZero, assertOutputIncludes, makeTempDir, readPin, removeDir } from '../../support/repo.mts';
import { sha256, upstreamIconHashes, upstreamPublicFiles } from '../../support/upstream.mts';
import {
	assertArtifact, cspMetas, probeEnvironment, probeOrigins, requireWorkspaceScript, webBuild,
} from '../../support/webBundle.mts';

const minute = 60_000;
const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const machOMagics = [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe]].map(b => Buffer.from(b));

describe('M1-AC5 build (full upstream recipe; opt-in)', () => {
	const temps: string[] = [];
	after(() => temps.forEach(removeDir));

	it('T90 build produces a verified, overlaid, architecture-neutral bundle of the pinned commit', () => {
		// Contract first (cheap), so a missing script fails in seconds, not after the interlock.
		requireWorkspaceScript('build');
		assert.ok(process.arch !== 'arm64' || process.env.NOTESTEAD_ALLOW_ARM64_WEB_BUILD === '1',
			'Refusing to start the ~43-minute native arm64 web build. Set NOTESTEAD_ALLOW_ARM64_WEB_BUILD=1 to run it on this machine (one heavy job at a time).');

		const pin = readPin();
		const base = makeTempDir('m1s2-ac5-build');
		temps.push(base);
		const work = process.env.NOTESTEAD_BUILD_WORK ?? join(base, 'work');
		if (!process.env.NOTESTEAD_BUILD_WORK) temps.push(work);
		const out = join(base, 'out');
		const r = webBuild('T90-build', 'build', ['--out', out, '--work', work], { timeoutMs: 180 * minute });
		assertExitZero(r);
		// The recipe is echoed: the onenote converter build is skipped and app-mobile's `yarn web` runs.
		assertOutputIncludes(r, 'SKIP_ONENOTE_CONVERTER_BUILD=1', 'build must echo the recipe environment');
		assertOutputIncludes(r, /yarn web\b/, 'build must echo the app-mobile web recipe');

		const extractInto = join(base, 'extract');
		mkdirSync(extractInto);
		const { extracted } = assertArtifact('T90', out, pin, extractInto, null);

		for (const path of ['index.html', 'app.bundle.js', 'serviceWorker.bundle.js', 'environment.js', 'manifest.json', 'source.html']) {
			assert.ok(extracted.has(path), `the bundle must contain ${path}`);
		}
		assert.ok([...extracted.keys()].some(p => p.endsWith('.wasm')), 'the bundle must contain the wasm assets');

		// Built from the pinned commit: upstream static files the overlay does not touch are byte-identical.
		const upstream = upstreamPublicFiles();
		for (const path of ['index.css', 'info-page.css']) {
			const content = extracted.get(path);
			assert.ok(content && upstream.get(path)?.equals(content), `${path} must equal upstream's at ${pin.web.commit}`);
		}
		const upstreamIndex = upstream.get('index.html')?.toString('utf8') ?? '';
		assert.deepEqual(cspMetas(extracted.get('index.html')?.toString('utf8') ?? ''), cspMetas(upstreamIndex), 'CSP <meta> identical to upstream');

		// Overlaid: no upstream icon bytes anywhere, dev mode off on every origin, and our own verify passes.
		const iconHashes = upstreamIconHashes();
		for (const [path, content] of extracted) {
			assert.ok(!iconHashes.has(sha256(content)), `${path} is upstream's ${iconHashes.get(sha256(content))}`);
			const head = content.subarray(0, 4);
			assert.ok(!head.equals(elfMagic) && !machOMagics.some(m => head.equals(m)), `${path} is a native binary; the bundle must be architecture-neutral`);
		}
		const environment = extracted.get('environment.js')?.toString('utf8') ?? '';
		for (const origin of probeOrigins) assert.equal(probeEnvironment(environment, origin).dev, false, `__DEV__ on ${origin}`);
		assertExitZero(webBuild('T90-verify-extracted', 'verify', [extractInto]));
	});
});
