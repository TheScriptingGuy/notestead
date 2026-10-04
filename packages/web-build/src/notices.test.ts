// Synthetic upstream-like trees written from scratch (our own manifests and texts). Standard texts come from the
// pinned spdx-license-list package, as in production.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseExceptions } from './licenseExceptions.ts';
import { bannerPackages, dependencyClosure, fallbackMarker, generateNotices, parseResolutionKey, writeNotices } from './notices.ts';
import type { NoticesInput } from './notices.ts';
import { installedPackages } from './installedPackages.ts';
import { loadStandardTexts } from './spdxTexts.ts';
import { removeTempDirs, tempDir, webBuildDir, writeFiles } from './testing/fixtures.ts';

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
const lockEntry = (key: string, version: string, resolution: string, deps: Record<string, string> = {}): string => [
	`"${key}":`, `  version: ${version}`, `  resolution: "${resolution}"`,
	...(Object.keys(deps).length > 0 ? ['  dependencies:', ...Object.entries(deps).map(([n, r]) => `    ${n}: "${r}"`)] : []),
	'  languageName: node', '  linkType: hard', '',
].join('\n');
const pkg = (name: string, version: string, fields: Record<string, unknown> = {}): string => json({ name, version, ...fields });

const tree = (): string => {
	const root = tempDir('upstream');
	writeFiles(root, {
		'package.json': json({ private: true, workspaces: ['packages/*'], resolutions: { 'pinned-dep': '2.0.0', 'lib-dep/native-only': 'link:./empty' } }),
		'packages/app-mobile/package.json': pkg('@up/app-mobile', '1.0.0', {
			dependencies: { '@up/lib': '~1.0', '@up/fork': '^1.0.0', 'alias-cjs': 'npm:real-pkg@^1.0.0', 'pinned-dep': '^1.0.0', 'declared-only': '1.0.0' },
			devDependencies: { 'dev-only': '1.0.0' },
		}),
		'packages/lib/package.json': pkg('@up/lib', '1.0.3', { license: 'MIT', dependencies: { 'lib-dep': '^3.0.0' } }),
		'packages/fork/package.json': pkg('@up/fork', '1.0.5', { license: 'BSD-3-Clause' }),
		'packages/fork/LICENSE': 'Fork licence text.\n',
		'yarn.lock': [
			'__metadata:\n  version: 8\n',
			lockEntry('@up/lib@npm:~1.0, @up/lib@workspace:packages/lib', '0.0.0-use.local', '@up/lib@workspace:packages/lib', { 'lib-dep': 'npm:^3.0.0', 'dev-only': 'npm:1.0.0' }),
			lockEntry('@up/fork@npm:^1.0.0, @up/fork@workspace:packages/fork', '0.0.0-use.local', '@up/fork@workspace:packages/fork'),
			lockEntry('alias-cjs@npm:real-pkg@^1.0.0, real-pkg@npm:^1.0.0', '1.2.0', 'real-pkg@npm:1.2.0'),
			lockEntry('pinned-dep@npm:2.0.0', '2.0.0', 'pinned-dep@npm:2.0.0'),
			lockEntry('pinned-dep@npm:^1.0.0', '1.9.0', 'pinned-dep@npm:1.9.0'),
			lockEntry('lib-dep@npm:^3.0.0', '3.1.0', 'lib-dep@npm:3.1.0', { 'native-only': 'npm:^1.0.0' }),
			lockEntry('native-only@link:./empty::locator=root%40workspace%3A.', '0.0.0-use.local', 'native-only@link:./empty::locator=root%40workspace%3A.'),
			lockEntry('declared-only@npm:1.0.0', '1.0.0', 'declared-only@npm:1.0.0'),
			lockEntry('dev-only@npm:1.0.0', '1.0.0', 'dev-only@npm:1.0.0'),
		].join('\n'),
		'node_modules/real-pkg/package.json': pkg('real-pkg', '1.2.0', { license: 'ISC' }),
		'node_modules/real-pkg/licence.md': 'Real package licence.\r\n',
		'node_modules/pinned-dep/package.json': pkg('pinned-dep', '2.0.0', { license: 'MIT' }),
		'node_modules/pinned-dep/LICENSE-MIT': 'Pinned licence.\n',
		'packages/lib/node_modules/lib-dep/package.json': pkg('lib-dep', '3.1.0', { license: 'Apache-2.0' }),
		'packages/lib/node_modules/lib-dep/LICENSE': 'Lib dep licence.\n',
		'packages/lib/node_modules/lib-dep/NOTICE': 'Lib dep notice.\n',
		'node_modules/declared-only/package.json': pkg('declared-only', '1.0.0', { license: '(MIT OR Apache-2.0)', author: { name: 'Fixture Author', email: 'a@example.invalid' }, repository: { url: 'https://example.invalid/d.git' } }),
		'node_modules/bannered/package.json': pkg('bannered', '4.0.0', { license: 'MIT' }),
		'node_modules/bannered/cjs/bannered-client.production.js': '',
		'node_modules/bannered/LICENSE': 'Bannered licence.\n',
		'node_modules/named/package.json': pkg('named', '0.1.0', { license: 'MIT' }),
		'node_modules/named/COPYING': 'Named licence.\n',
		'node_modules/proseonly/package.json': pkg('proseonly', '1.0.0', { license: 'MIT' }),
		'node_modules/proseonly/node.js': '',
	});
	mkdirSync(join(root, 'packages/app-mobile/node_modules/@up'), { recursive: true });
	symlinkSync('../../../lib', join(root, 'packages/app-mobile/node_modules/@up/lib'));
	return root;
};

const bundle = (): string => {
	const dir = tempDir('bundle');
	writeFiles(dir, { 'chunks/app.bundle.js.LICENSE.txt': [
		'/*!\n * named\n * (c) Someone\n */',
		'/**\n * @license Fixture\n * bannered-client.production.js\n */',
		'/*! The buffer module from node.js, for the browser. */',
		'/* !\n * @license\n * Original text with no package\n */',
	].join('\n\n') });
	return dir;
};

const input = (root: string, exceptions: unknown[] = []): NoticesInput => ({
	tree: root,
	bundle: bundle(),
	exceptions: parseExceptions({ exceptions }, 'exc.json'),
	exceptionsLabel: 'exc.json',
	texts: loadStandardTexts(webBuildDir),
});

describe('notices', () => {
	afterAll(removeTempDirs);

	test('parses the forms of yarn resolution keys', () => {
		expect(parseResolutionKey('nanoid', 'x')).toEqual({ name: 'nanoid', parent: null, range: null, value: 'x' });
		expect(parseResolutionKey('chokidar@^2.0.0', 'x')).toMatchObject({ name: 'chokidar', parent: null, range: '^2.0.0' });
		expect(parseResolutionKey('@scope/a@npm:1.0.0', 'x')).toMatchObject({ name: '@scope/a', parent: null, range: 'npm:1.0.0' });
		expect(parseResolutionKey('@huggingface/transformers/sharp', 'x')).toMatchObject({ name: 'sharp', parent: '@huggingface/transformers', range: null });
		expect(parseResolutionKey('parent/@scope/child@1.0.0', 'x')).toMatchObject({ name: '@scope/child', parent: 'parent', range: '1.0.0' });
	});

	test('the closure follows workspace dependencies, lockfile dependencies, resolutions and aliases', () => {
		expect([...dependencyClosure(tree()).values()]).toEqual([
			{ name: '@up/lib', version: '1.0.3', workspace: 'packages/lib' },
			{ name: '@up/fork', version: '1.0.5', workspace: 'packages/fork' },
			{ name: 'real-pkg', version: '1.2.0', workspace: null },
			{ name: 'pinned-dep', version: '2.0.0', workspace: null },
			{ name: 'declared-only', version: '1.0.0', workspace: null },
			{ name: 'lib-dep', version: '3.1.0', workspace: null },
		]);
	});

	test('banners name packages by first line, by shipped file name and by reviewed phrase; prose is not a file name', () => {
		const root = tree();
		writeFiles(root, { 'node_modules/buffer/package.json': pkg('buffer', '6.0.3', { license: 'MIT' }) });
		const result = bannerPackages(bundle(), installedPackages(root));
		expect(result.packages.map(p => `${p.name}@${p.version}`).sort()).toEqual(['bannered@4.0.0', 'buffer@6.0.3', 'named@0.1.0']);
		expect(result.unresolved).toEqual(['chunks/app.bundle.js.LICENSE.txt: @license']);
	});

	test('entries follow the ADR-0010 precedence and the format contract', () => {
		const result = generateNotices(input(tree()));
		expect(result.problems).toEqual([]);
		const text = result.text;
		expect(text).toContain('Package: @up/lib@1.0.3\nLicense: AGPL-3.0-or-later\n\nPart of upstream Joplin (packages/lib)');
		expect(text).toContain('(Its package.json declares "MIT"; upstream\'s repository licence applies');
		expect(text).toContain('Package: @up/fork@1.0.5\nLicense: BSD-3-Clause\n\nLicence file: LICENSE\n\nFork licence text.\n');
		expect(text).toContain('Package: real-pkg@1.2.0\nLicense: ISC\n\nLicence file: licence.md\n\nReal package licence.\n');
		expect(text).toContain('Licence file: LICENSE\n\nLib dep licence.\n\nLicence file: NOTICE\n\nLib dep notice.\n');
		expect(text).toContain(`Package: declared-only@1.0.0\nLicense: (MIT OR Apache-2.0)\n\n${fallbackMarker('(MIT OR Apache-2.0)')}\nAuthor: Fixture Author <a@example.invalid>\nContributors: not declared\nRepository: https://example.invalid/d.git\n`);
		expect(text).toMatch(/Standard text of MIT \(spdx-license-list@[\d.]+\):\n\nMIT License\n\nCopyright \(c\) <year> <copyright holders>/);
		expect(text).toContain('Standard text of Apache-2.0');
		expect(text).toContain('Package: bannered@4.0.0\n');
		expect(text).not.toContain('dev-only');
		expect(text).not.toContain('Package: proseonly');
		expect(text.match(/^Package: /gm)).toHaveLength(8);
	});

	test('an exception noticeText takes precedence over the standard text; unusable declarations fail, naming the package', () => {
		const root = tree();
		const excepted = generateNotices(input(root, [{ name: 'declared-only', version: '1.0.0', license: 'MIT', evidence: 'repo', reason: 'reviewed fixture', noticeText: 'Established text.' }]));
		expect(excepted.text).toContain('Package: declared-only@1.0.0\nLicense: MIT\n\nLicence text: from the reviewed exception list (exc.json); no licence file in the package\nDeclared licence: (MIT OR Apache-2.0)\nEvidence: repo\nReason: reviewed fixture\n\nEstablished text.\n');

		for (const license of ['GPL-2.0-or-later WITH Classpath-exception-2.0', 'LicenseRef-Mine', 'Apache 2', 'UNLICENSED']) {
			writeFiles(root, { 'node_modules/declared-only/package.json': pkg('declared-only', '1.0.0', { license }) });
			const out = join(tempDir('out'), 'n.txt');
			const result = writeNotices(input(root), out);
			expect(result.problems).toEqual([`declared-only@1.0.0 (node_modules/declared-only): no licence file, no usable declared licence (${JSON.stringify(license)}), and no exception with a noticeText in exc.json`]);
			expect(existsSync(out)).toBe(false);
		}
		const noText = generateNotices(input(root, [{ name: 'declared-only', version: '1.0.0', license: 'MIT', evidence: 'repo', reason: 'reviewed' }]));
		expect(noText.problems).toEqual([expect.stringContaining('and its exception in exc.json has no noticeText')]);
	});

	test('refuses a licence text that would forge an entry header', () => {
		const root = tree();
		writeFiles(root, { 'node_modules/real-pkg/licence.md': 'Text\nPackage: react@19.0.0\nLicense: MIT\n' });
		expect(generateNotices(input(root)).problems).toEqual([expect.stringMatching(/^real-pkg@1\.2\.0: its licence file licence\.md contains a line that looks like/)]);
	});
});
