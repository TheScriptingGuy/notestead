// M1-S5 contract suite, M1-AC23: the headless image gets the CLI's native sqlite3 binding from this repo's yarn.lock
// through an explicit install-script allow-list (ADR-0009 A4). docs/test-plans/M1-S5.md. The image is inspected with
// its entrypoint replaced by tests/fixtures/m1-s5/in-container/image-probe.mjs; nothing of the supervisor runs.
// The NEG (a non-allow-listed postinstall in the same build) is in install-scripts.test.ts.
import { beforeAll, describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import {
	appPackages, expectedMachine, headlessImage, hostPackageDirs, ownerOf, podmanArch, probeImage, readFullPin, runLogged,
} from '../support/headless.ts';
import type { ImageProbe } from '../support/headless.ts';
import { lockAllows, readLock } from '../support/lockfile.ts';
import { podman, repoRoot } from '../support/podman.ts';

describe('M1-S5 headless image (M1-AC23)', () => {
	describe('the built image', () => {
		let image: string;
		let probe: ImageProbe;
		const pin = readFullPin();
		const lock = readLock(join(repoRoot, 'yarn.lock'));

		beforeAll(() => {
			image = headlessImage();
			probe = probeImage(image, 'image');
		}, 90 * 60_000);

		test('ac23-arch: the image is built natively for this machine (arm64 on the Pi, amd64 in x64 CI)', () => {
			expect(podman(['image', 'inspect', '--format', '{{.Architecture}}', image]).stdout.trim()).toBe(podmanArch());
			expect(probe.arch).toBe(process.arch);
		});

		test('ac23-sqlite3: require("sqlite3") resolved from the installed joplin package loads its native binding and runs a query', () => {
			expect(probe.joplin.length).toBeGreaterThan(0);
			for (const j of probe.joplin) {
				expect(j.sqlite3?.error).toBeUndefined();
				expect(j.sqlite3?.bindingError).toBeUndefined();
				expect(j.sqlite3?.bindingMachine).toBe(expectedMachine());
				expect(j.sqlite3?.query?.version).toMatch(/^3\.\d+\.\d+$/);
				expect(lockAllows(lock, 'sqlite3', String(j.sqlite3?.version))).toBe(true);
			}
		});

		test('ac23-version: `joplin version` in the image prints the pinned cli.version', () => {
			expect(probe.joplin.length).toBeGreaterThan(0);
			for (const j of probe.joplin) {
				expect({ dir: j.dir, code: j.version?.code }).toEqual({ dir: j.dir, code: 0 });
				expect(j.version?.stdout).toMatch(new RegExp(`^joplin ${pin.cli.version.replace(/\./g, '\\.')} \\(`, 'm'));
			}
		});

		test('ac23-lock: every installed joplin, @joplin/* and sqlite3 package has a version from yarn.lock; joplin is cli.version', () => {
			const relevant = appPackages(probe).filter(p => p.name === 'joplin' || p.name.startsWith('@joplin/') || p.name === 'sqlite3');
			expect(relevant.filter(p => p.name === 'joplin').map(p => p.version)).toEqual(expect.arrayContaining([pin.cli.version]));
			expect(relevant.filter(p => p.name === 'joplin' && p.version !== pin.cli.version)).toEqual([]);
			expect(relevant.some(p => p.name === '@joplin/lib')).toBe(true);
			expect(relevant.filter(p => !lockAllows(lock, p.name, p.version)).map(p => `${p.name}@${p.version} (${p.dir})`)).toEqual([]);
		});

		test('ac23-lock-all: no installed package outside yarn.lock (no npm resolution slipped in)', () => {
			const offenders = appPackages(probe).filter(p => !lockAllows(lock, p.name, p.version)).map(p => `${p.name}@${p.version} (${p.dir})`);
			expect(offenders).toEqual([]);
		});

		test('ac23-no-other-builds: no native binary was built except sqlite3 (keytar and sharp stay unbuilt)', () => {
			const host = hostPackageDirs();
			// Reference self-check: this repo's install ran no install scripts for keytar.
			for (const dir of host.get([...host.keys()].find(k => k.startsWith('keytar@')) ?? '') ?? []) expect(existsSync(join(dir, 'build'))).toBe(false);
			const unexplained: string[] = [];
			for (const file of probe.nodeFiles) {
				const owner = ownerOf(probe, file);
				if (!owner || owner.name === 'sqlite3' || appPackages(probe).every(p => p.dir !== owner.dir)) continue;
				const rel = relative(owner.dir, file);
				const shipped = (host.get(`${owner.name}@${owner.version}`) ?? []).some(dir => existsSync(join(dir, rel)));
				if (!shipped) unexplained.push(`${file} (${owner.name}@${owner.version})`);
			}
			expect(unexplained).toEqual([]);
			for (const name of ['keytar', 'sharp']) {
				for (const p of appPackages(probe).filter(q => q.name === name)) expect(probe.nodeFiles.filter(f => f.startsWith(`${p.dir}/`))).toEqual([]);
			}
		});
	});

	// A repo-level guard that needs no image (it holds before M1-S5 and must keep holding).
	describe('the install-script default', () => {
		test('ac23-static: install scripts stay off by default in this repo (enableScripts is false; no global override)', () => {
			const yarnrc = parse(readFileSync(join(repoRoot, '.yarnrc.yml'), 'utf8')) as Record<string, unknown>;
			expect(yarnrc.enableScripts === true || yarnrc.enableScripts === 'true').toBe(false);
			const env: NodeJS.ProcessEnv = { ...process.env };
			delete env.YARN_ENABLE_SCRIPTS;
			const r = runLogged('yarn-config-enableScripts', 'corepack', ['yarn', 'config', 'get', 'enableScripts', '--json'], { env });
			expect(r.code).toBe(0);
			expect(JSON.parse(r.stdout)).toBe(false);
		});
	});
});
