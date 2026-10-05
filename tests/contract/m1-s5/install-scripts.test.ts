// M1-S5 contract suite, M1-AC23 NEG: install scripts run only for allow-listed packages (ADR-0009 A4). A fixture
// dependency whose `postinstall` writes a marker file is added to packages/headless in a clean copy of the repository
// (with the matching yarn.lock entry), and the image is built from that copy with the same Containerfile. The fixture
// must be installed in the image, its marker must be absent, and the allow-listed sqlite3 must still be built.
// docs/test-plans/M1-S5.md §M1-AC23.
import { describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildHeadlessFrom, cleanContext, lazyImage, probeImage, runLogged } from '../support/headless.ts';
import { readLock } from '../support/lockfile.ts';

const fixtureName = 'notestead-fixture-postinstall';
const markerName = 'notestead-postinstall-ran';
const negTag = 'localhost/notestead-headless:m1-s5-neg';

// The fixture package (generated, never committed as a package.json, so no tool picks it up). Its postinstall writes
// the marker into its own directory (which is in the image when the package is) and into the install's cwd.
const writeFixture = (dir: string): void => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
		name: fixtureName,
		version: '1.0.0',
		private: true,
		license: 'MIT',
		description: 'M1-AC23 NEG fixture: a postinstall that must not run',
		main: 'index.js',
		scripts: { postinstall: 'node postinstall.cjs' },
	}, null, '\t')}\n`);
	writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
	writeFileSync(join(dir, 'postinstall.cjs'), [
		"const { writeFileSync } = require('node:fs');",
		"const { join } = require('node:path');",
		`writeFileSync(join(__dirname, '${markerName}'), 'postinstall ran\\n');`,
		`try { writeFileSync(join(process.env.INIT_CWD || process.cwd(), '${markerName}'), 'postinstall ran\\n'); } catch (error) { /* best effort */ }`,
		'',
	].join('\n'));
};

describe('M1-S5 install-script allow-list (M1-AC23 NEG)', () => {
	test('ac23-neg: a non-allow-listed postinstall installed in the same build does not run; the fixture is installed and sqlite3 is still built', () => {
		const work = process.env.NOTESTEAD_CONTRACT_WORK;
		if (!work) throw new Error('the contract globalSetup did not run: use `corepack yarn jest -c jest.contract.config.js`');

		// Fixture control: the postinstall really writes the marker when it runs.
		const scratch = mkdtempSync(join(tmpdir(), 'm1s5-fixture-'));
		try {
			writeFixture(scratch);
			const ran = spawnSync(process.execPath, ['postinstall.cjs'], { cwd: scratch, env: { ...process.env, INIT_CWD: scratch }, encoding: 'utf8' });
			expect(ran.status).toBe(0);
			expect(existsSync(join(scratch, markerName))).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}

		// A clean copy of the repository with the fixture as a dependency of packages/headless.
		const context = join(work, 'neg-context');
		cleanContext(context);
		writeFixture(join(context, 'packages', 'headless', 'test-fixtures', fixtureName));
		const manifestPath = join(context, 'packages', 'headless', 'package.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
		manifest.dependencies = { ...(manifest.dependencies ?? {}), [fixtureName]: `file:./test-fixtures/${fixtureName}` };
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const before = readLock(join(context, 'yarn.lock'));
		const locked = runLogged('neg-update-lockfile', 'corepack', ['yarn', 'install', '--mode=update-lockfile'], {
			cwd: context,
			env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', FORCE_COLOR: '0' },
			timeoutMs: 20 * 60_000,
		});
		expect({ code: locked.code, log: locked.log }).toEqual({ code: 0, log: locked.log });
		const after = readLock(join(context, 'yarn.lock'));
		const added = [...after.entries.keys()].filter(k => !before.entries.has(k));
		expect(added.length).toBeGreaterThan(0);
		expect(added.every(k => k.startsWith(`${fixtureName}@`))).toBe(true);
		for (const [key, entry] of before.entries) {
			if (key.startsWith('headless@')) continue; // the workspace's own entry lists the new dependency
			expect({ key, entry: after.entries.get(key) }).toEqual({ key, entry });
		}

		// The same Containerfile builds the fixture-carrying copy.
		const image = lazyImage('neg', () => {
			buildHeadlessFrom(context, negTag, 'build-headless-neg');
			return { image: negTag };
		});
		const probe = probeImage(image, 'neg');

		expect(probe.packages.filter(p => p.name === fixtureName).map(p => p.version)).toContain('1.0.0');
		expect(probe.markers).toEqual([]);
		expect(probe.joplin.length).toBeGreaterThan(0);
		for (const j of probe.joplin) expect(j.sqlite3?.query?.version).toMatch(/^3\.\d+\.\d+$/);
	}, 90 * 60_000);
});
