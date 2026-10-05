// M1-AC28 real-dist variant (opt-in, local; not matched by the default `*.test.mts` glob): a copy of a real upstream
// `yarn web` output (default: the spike S1 build) → placeholder notices → overlay → package → import. The imported
// dist must equal the packaged one byte for byte. Before the first push this is the Pi's stand-in for a CI-built
// artifact (docs/backlog/M1.md M1-AC28).
//   NOTESTEAD_REAL_DIST=<dist> NOTESTEAD_ARTIFACT_OUT=<new or empty dir, optional> \
//     node --test --test-reporter=spec tests/acceptance/m1-s4/optin/ac28-real-dist.optin.mts
// With NOTESTEAD_ARTIFACT_OUT the packaged artifact is kept there, so the contract suite can build the web image from
// it: NOTESTEAD_WEB_ARTIFACT=<that dir> corepack yarn jest -c jest.contract.config.js (docs/test-plans/M1-S4.md).
import assert from 'node:assert/strict';
import { cpSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertExitZero, makeTempDir, readPin, removeDir } from '../../support/repo.mts';
import { sha256 } from '../../support/upstream.mts';
import { artifactName, readTree } from '../../support/webBundle.mts';
import { noticesName, readManifest, runImport, upstreamArgs, webBuild } from '../../support/webImport.mts';

const realDist = process.env.NOTESTEAD_REAL_DIST
	?? join(homedir(), 'joplin-web-app-work', 'spikes', 'S1', 'joplin', 'packages', 'app-mobile', 'web', 'dist');
const keep = process.env.NOTESTEAD_ARTIFACT_OUT ? resolve(process.env.NOTESTEAD_ARTIFACT_OUT) : null;

describe('M1-AC28 import of a locally packaged real bundle (opt-in)', () => {
	const temps: string[] = [];
	after(() => temps.forEach(removeDir));

	it('I90 package(real dist, overlaid) → import yields the same bundle, byte for byte, and verify passes', () => {
		assert.ok(existsSync(join(realDist, 'index.html')) && existsSync(join(realDist, 'app.bundle.js')),
			`no built bundle at ${realDist}; set NOTESTEAD_REAL_DIST to an upstream \`yarn web\` output`);
		if (keep) assert.ok(!existsSync(keep) || readdirSync(keep).length === 0, `NOTESTEAD_ARTIFACT_OUT must be a new or empty dir: ${keep}`);
		const base = makeTempDir('m1s4-real');
		temps.push(base);
		const dist = join(base, 'dist');
		cpSync(realDist, dist, { recursive: true });
		writeFileSync(join(dist, noticesName), 'Third-party notices (M1-S4 I90 placeholder; the real notices are M1-S9 T490/T491)\n');
		assertExitZero(webBuild('I90-overlay', 'overlay', [dist]));
		const packaged = readTree(dist);
		const artifact = keep ?? join(base, 'artifact');
		assertExitZero(webBuild('I90-package', 'package', [dist, '--out', artifact]));
		assert.ok(existsSync(join(artifact, artifactName(readPin()))), 'package wrote the tarball');

		const out = join(base, 'imported');
		assertExitZero(runImport('I90-import', artifact, out));
		const imported = readTree(out);
		assert.deepEqual([...imported.keys()].sort(), [...packaged.keys()].sort(), 'the imported dist has exactly the packaged files');
		for (const [path, content] of packaged) assert.ok(imported.get(path)?.equals(content), `${path} differs after import`);
		for (const file of readManifest(artifact).files ?? []) assert.equal(sha256(imported.get(file.path) ?? Buffer.alloc(0)), file.sha256, file.path);
		assertExitZero(webBuild('I90-verify-imported', 'verify', [...upstreamArgs(), out]));
	});
});
