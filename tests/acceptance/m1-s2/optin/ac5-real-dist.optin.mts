// Local proxy for M1-AC5..AC7 on a real built bundle, without the 43-minute build: copies an existing upstream
// `yarn web` output, then runs overlay → verify → package and checks the artifact. Opt-in (not matched by the default
// `*.test.mts` glob) because the bundle is not in the repo and never committed:
//   NOTESTEAD_REAL_DIST=<dist> node --test --test-reporter=spec tests/acceptance/m1-s2/optin/ac5-real-dist.optin.mts
// Default dist: the spike S1 output ~/joplin-web-app-work/spikes/S1/joplin/packages/app-mobile/web/dist.
// Test plan: docs/test-plans/M1-S2.md.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertExitZero, makeTempDir, readPin, removeDir } from '../../support/repo.mts';
import { sha256, upstreamIconHashes, upstreamPublicFiles } from '../../support/upstream.mts';
import { assertArtifact, cspMetas, probeEnvironment, probeOrigins, readTree, webBuild } from '../../support/webBundle.mts';

const realDist = process.env.NOTESTEAD_REAL_DIST
	?? join(homedir(), 'joplin-web-app-work', 'spikes', 'S1', 'joplin', 'packages', 'app-mobile', 'web', 'dist');

describe('M1-AC5..AC7 on a real upstream bundle (opt-in, local)', () => {
	const temps: string[] = [];
	after(() => temps.forEach(removeDir));

	it('T95 overlay → verify → package on a copy of a real dist yields a clean, complete artifact', () => {
		assert.ok(existsSync(join(realDist, 'index.html')) && existsSync(join(realDist, 'app.bundle.js')),
			`no built bundle at ${realDist}; set NOTESTEAD_REAL_DIST to an upstream \`yarn web\` output`);
		const original = readTree(realDist);
		const iconHashes = upstreamIconHashes();
		assert.ok([...original.values()].some(c => iconHashes.has(sha256(c))), 'fixture sanity: the real dist must contain upstream icons before the overlay');

		const base = makeTempDir('m1s2-real-dist');
		temps.push(base);
		const dist = join(base, 'dist');
		cpSync(realDist, dist, { recursive: true });

		assertExitZero(webBuild('T95-overlay', 'overlay', [dist]));
		assertExitZero(webBuild('T95-verify', 'verify', [dist]));
		const overlaid = readTree(dist);
		const out = join(base, 'out');
		assertExitZero(webBuild('T95-package', 'package', [dist, '--out', out]));
		const extractInto = join(base, 'extract');
		mkdirSync(extractInto);
		const { extracted } = assertArtifact('T95', out, readPin(), extractInto, overlaid);

		for (const [path, content] of extracted) assert.ok(!iconHashes.has(sha256(content)), `${path} is upstream's ${iconHashes.get(sha256(content))}`);
		const upstreamIndex = upstreamPublicFiles().get('index.html')?.toString('utf8') ?? '';
		assert.deepEqual(cspMetas(extracted.get('index.html')?.toString('utf8') ?? ''), cspMetas(upstreamIndex), 'CSP <meta> identical to upstream');
		const environment = extracted.get('environment.js')?.toString('utf8') ?? '';
		for (const origin of probeOrigins) assert.equal(probeEnvironment(environment, origin).dev, false, `__DEV__ on ${origin}`);
		// The overlay edits static files only: every webpack output is byte-identical to the original build.
		for (const [path, content] of original) {
			if (/\.(bundle\.js|wasm|ttf)$/.test(path) || path.startsWith('pluginAssets/')) {
				assert.ok(extracted.get(path)?.equals(content), `${path} must be byte-identical to the original build`);
			}
		}
	});
});
