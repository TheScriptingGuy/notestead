// The pure parts of the derived test bundles (docs/test-plans/M2-S5.md D1-D3, harness items tb-01…08): they work on synthetic
// strings built here, never on bytes of the real bundle (upstream's files are never committed).
import { describe, expect, test } from '@jest/globals';
import { appendLine, dropNewestMigration, manifestWith, migrationVersions } from '../../e2e/support/testBundles.ts';
import type { BundleManifest } from '../../e2e/support/testBundles.ts';

const databaseTs = (last: number): string => `// header\n\t\tconst existingDatabaseVersions = [${Array.from({ length: last + 1 }, (_, i) => i).join(', ')}];\n\n\t\tfor (let i = 0; i < migrations.length; i++) push();\n`;
const indexTs = (n: number): string => {
	const names = Array.from({ length: n }, (_, i) => `migration${42 + i}`);
	return `${names.map(x => `import ${x} from './${x.slice(9)}';`).join('\n')}\n\nconst index: Migration[] = [\n${names.map(x => `\t${x},`).join('\n')}\n];\n\nexport default index;\n`;
};

// A synthetic webpack-style pair of modules: the database module looks its migration up by `e-<base+1>`, and the index module
// exports the array of `n` entries.
const fakeBundle = (n: number, opts: { anchors?: number; module?: string; second?: boolean } = {}): string => {
	const anchors = opts.anchors ?? 1;
	const lookups = Array.from({ length: anchors }, () => 'if(e>41){var O=b.default[e-42];if(!O)throw new Error(`No such migration: ${e}`)}').join(';');
	const id = opts.module ?? '123';
	const entries = Array.from({ length: n }, (_, i) => `${String.fromCharCode(97 + i)}.default`);
	const decls = entries.map((e, i) => `${e.split('.')[0]}=r(n(${1000 + i}))`).join(',');
	const extra = opts.second ? ';var z=[q.default,w.default,u.default]' : '';
	return `(()=>{var M={1:function(e,t,n){var r=this&&this.__importDefault||function(e){return e},b=r(n(${id}));${lookups}},${id}:function(e,t,n){"use strict";var r=this&&this.__importDefault||function(e){return e},${decls},y=[${entries.join(',')}]${extra};t.default=y},456:(e,t)=>{"use strict";t.default=1}}})();`;
};

describe('derived test bundles', () => {
	test('tb-01 migrationVersions reads the last version of the literal and counts the migrations', () => {
		expect(migrationVersions(databaseTs(41), indexTs(13))).toEqual({ base: 41, n: 13, latest: 54 });
		expect(migrationVersions(databaseTs(41), indexTs(2))).toEqual({ base: 41, n: 2, latest: 43 });
	});

	test('tb-02 migrationVersions throws naming what it found when a source has no literal or no entries', () => {
		expect(() => migrationVersions('const nothing = 1;', indexTs(13))).toThrow(/existingDatabaseVersions/);
		expect(() => migrationVersions(databaseTs(41), 'export default [];')).toThrow(/migrations|entries/);
		expect(() => migrationVersions(databaseTs(41), 'const index: Migration[] = [\n];\n')).toThrow(/0 entries|no entries|found 0/);
	});

	test('tb-03 appendLine adds a newline only when the text has none and leaves every other byte', () => {
		expect(appendLine('a;\nb;', '// m')).toBe('a;\nb;\n// m\n');
		expect(appendLine('a;\nb;\n', '// m')).toBe('a;\nb;\n// m\n');
		expect(appendLine('', '// m')).toBe('\n// m\n');
	});

	test('tb-04 dropNewestMigration removes the last entry of the array and nothing else', () => {
		const before = fakeBundle(13);
		const r = dropNewestMigration(before, { base: 41, n: 13 });
		expect(r.before).toBe(13);
		expect(r.after).toBe(12);
		expect(r.js).toBe(before.replace(',m.default]', ']'));
		expect(r.js).not.toBe(before);
		// the 13th entry is the one that went, the 12th is still the last
		expect(r.js).toContain('l.default]');
		expect(r.js).not.toContain('m.default]');
	});

	test('tb-05 dropNewestMigration throws with the counts when there is no anchor or its module is missing', () => {
		expect(() => dropNewestMigration(fakeBundle(13, { anchors: 0 }), { base: 41, n: 13 })).toThrow(/found 0|0 match|0 anchor/i);
		expect(() => dropNewestMigration(fakeBundle(13, { module: '999' }).replace('999:function', '998:function'), { base: 41, n: 13 })).toThrow(/module 999|no module/i);
	});

	test('tb-06 dropNewestMigration throws with the counts when the anchor matches more than once', () => {
		expect(() => dropNewestMigration(fakeBundle(13, { anchors: 2 }), { base: 41, n: 13 })).toThrow(/found 2|2 match|2 anchor/i);
	});

	test('tb-07 dropNewestMigration throws naming the expected and the found counts when n is wrong or the array is not unique', () => {
		expect(() => dropNewestMigration(fakeBundle(13), { base: 41, n: 14 })).toThrow(/expected 14.*found 13|found 13.*expected 14/i);
		expect(() => dropNewestMigration(fakeBundle(13, { second: true }), { base: 41, n: 13 })).toThrow(/2 arrays|found 2/i);
		// the thrown message never carries bundle text
		let message = '';
		try {
			dropNewestMigration(fakeBundle(13), { base: 41, n: 14 });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).not.toContain('importDefault');
		expect(message).not.toContain('default[');
	});

	test('tb-08 manifestWith replaces the changed files\' digest and size, marks the bundle and keeps every other entry', () => {
		const base: BundleManifest = {
			upstream: { repo: 'r', tag: 't', commit: 'c' },
			notestead: { commit: 'n', dirty: false },
			files: [{ path: 'a.js', sha256: 'aa', size: 1 }, { path: 'b.js', sha256: 'bb', size: 2 }],
		};
		const bytes = Buffer.from('changed');
		const m = manifestWith(base, [{ path: 'b.js', bytes }], 'B2');
		expect(m.notestead.testBundle).toBe('B2');
		expect(m.files[0]).toEqual({ path: 'a.js', sha256: 'aa', size: 1 });
		expect(m.files[1].path).toBe('b.js');
		expect(m.files[1].size).toBe(7);
		expect(m.files[1].sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(m.files[1].sha256).not.toBe('bb');
		// the input is untouched
		expect(base.files[1]).toEqual({ path: 'b.js', sha256: 'bb', size: 2 });
		expect(base.notestead.testBundle).toBeUndefined();
		expect(() => manifestWith(base, [{ path: 'nope.js', bytes }], 'B')).toThrow(/nope\.js/);
	});
});
