// The .jpl writer and the probe plugin builder (docs/test-plans/M2-S4.md D7). A .jpl is a tar archive; the independent
// oracle for our ustar writer (tests/support/ustar.ts) is the system's GNU tar.
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProbeJpl } from '../../e2e/support/pluginProbe.ts';
import { ustar } from '../../support/ustar.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';

const tar = (args: string[]): string => {
	const r = spawnSync('tar', args, { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`tar ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
	return r.stdout;
};

describe('plugin jpl (M2-S4 D7)', () => {
	let dir = '';
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'nst-jpl-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('jpl-01 tar lists exactly the entries in order', () => {
		const file = join(dir, 'a.tar');
		writeFileSync(file, ustar([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'index.js', data: Buffer.from('x') }]));
		expect(tar(['-tf', file])).toBe('manifest.json\nindex.js\n');
	});

	test('jpl-02 tar extracts every entry byte for byte', () => {
		const entries = [
			{ name: 'manifest.json', data: Buffer.from('{}') },
			{ name: 'index.js', data: Buffer.from('x') },
			{ name: 'a/b.txt', data: Buffer.from('é漢\n', 'utf8') },
		];
		const file = join(dir, 'b.tar');
		writeFileSync(file, ustar(entries));
		for (const e of entries) {
			const r = spawnSync('tar', ['-xOf', file, e.name]);
			expect(r.status).toBe(0);
			expect(Buffer.compare(r.stdout, e.data)).toBe(0);
		}
	});

	test('jpl-03 the archive is deterministic and block aligned', () => {
		const entries = [{ name: 'manifest.json', data: Buffer.from('{"a":1}') }, { name: 'index.js', data: Buffer.alloc(700, 7) }];
		const one = ustar(entries);
		const two = ustar(entries);
		const sum = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
		expect(sum(one)).toBe(sum(two));
		expect(one.length % 512).toBe(0);
		expect(one.subarray(one.length - 1024).every((b: number) => b === 0)).toBe(true);
		const file = join(dir, 'c.tar');
		writeFileSync(file, one);
		const listing = tar(['-tvf', file]);
		for (const line of listing.trim().split('\n')) {
			expect(line).toMatch(/^-rw-r--r-- 0\/0 /);
			expect(line).toContain('1970-01-01');
		}
	});

	test('jpl-04 bad names throw', () => {
		const bad: [string, string][] = [['a'.repeat(101), 'a'.repeat(101)], ['../x', '../x'], ['/x', '/x'], ['', 'empty']];
		for (const [name, shown] of bad) {
			expect(() => ustar([{ name, data: Buffer.from('x') }])).toThrow(Error);
			try {
				ustar([{ name, data: Buffer.from('x') }]);
			} catch (error) {
				expect((error as Error).message).toContain(shown);
			}
		}
	});

	test('jpl-05 the probe plugin manifest and marker', () => {
		const desktop = buildProbeJpl({ kind: 'desktop', run: 'r1', dir });
		const manifest = JSON.parse(tar(['-xOf', desktop.path, 'manifest.json'])) as Record<string, unknown>;
		expect(manifest).toMatchObject({ manifest_version: 1, id: 'org.notestead.test.probe-desktop', version: '1.0.0', app_min_version: '3.5', platforms: ['desktop'] });
		expect(typeof manifest.name === 'string' && manifest.name.length > 0).toBe(true);
		expect(desktop.id).toBe('org.notestead.test.probe-desktop');
		expect(desktop.marker).toBe('nst-plugin-probe-desktop-r1');
		const index = tar(['-xOf', desktop.path, 'index.js']);
		expect(index.split(JSON.stringify(desktop.marker)).length - 1).toBe(1);
		expect(index).not.toContain('__NST_MARKER__');
		expect(desktop.sha256).toBe(createHash('sha256').update(readFileSync(desktop.path)).digest('hex'));

		const mobile = buildProbeJpl({ kind: 'mobile', run: 'r1', dir });
		const m = JSON.parse(tar(['-xOf', mobile.path, 'manifest.json'])) as Record<string, unknown>;
		expect(m).toMatchObject({ id: 'org.notestead.test.probe-mobile', platforms: ['desktop', 'mobile'] });
		expect(mobile.marker).toBe('nst-plugin-probe-mobile-r1');
	});

	test('jpl-06 the probe source is ours', () => {
		const base = join(findRepoRoot(), 'tests', 'fixtures', 'plugins', 'probe');
		expect(existsSync(join(base, 'manifest.base.json'))).toBe(true);
		const index = readFileSync(join(base, 'index.js'), 'utf8');
		expect(index.split('\n')[0]).toMatch(/SPDX-License-Identifier: AGPL-3\.0-or-later/);
		expect(index).not.toContain('require(');
		expect(index).not.toContain('@joplin/');
	});
});
