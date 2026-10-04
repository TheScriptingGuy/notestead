// Synthetic licence texts only: upstream's own header is read at run time and never committed (ADR-0009 A10).
import { findLicenceHeaders, hasUpstreamLicenceHeader, parseUpstreamLicence, stripCommentMarkers, upstreamLicence } from './licenceHeader.ts';
import { gitRepo, removeTempDirs, writeFiles } from './testing/fixtures.ts';
import { git } from './upstreamCopy.ts';

const licenceText = '\nFixture repository statement: everything here is under the Fixture Licence\n\nSome terms.\n\nCopyright (c) 2001-2009 Fixture Holder\n';
const licence = parseUpstreamLicence(licenceText);
const header = 'Fixture repository statement: everything here is under the Fixture Licence';

describe('licenceHeader', () => {
	afterAll(removeTempDirs);

	test('derives the header (first non-empty line) and the copyright holder from the licence text', () => {
		expect(licence).toEqual({ header, holder: 'Fixture Holder' });
		expect(() => parseUpstreamLicence('\n\n')).toThrow('is empty');
		expect(() => parseUpstreamLicence('Statement only\n')).toThrow('has no "Copyright (c) <years> <holder>" line');
	});

	test('strips comment markers and surrounding whitespace', () => {
		expect(['// x', '# x', ' * x', '/* x */', '/*! x', '<!-- x -->', '; x', '-- x', '> x', '\tx  '].map(stripCommentMarkers)).toEqual(Array(10).fill('x'));
	});

	test.each([
		['a // comment block', `// ${header}\n//\n// Copyright (c) 2001-2009 Fixture Holder\n`],
		['raw lines', `# Title\n\n${header}\n\nCopyright (c) 2001-2009 Fixture Holder\n`],
		['another year range in # comments', `# ${header}\n# Copyright (c) 1999 Fixture Holder\n`],
		['a block comment', `/*\n * ${header}\n * Copyright (C) 2001, 2005 Fixture Holder.\n */\n`],
	])('flags the header with the copyright line: %s', (_label, content) => {
		expect(hasUpstreamLicenceHeader(content, licence)).toBe(true);
	});

	test.each([
		['our own header', '// SPDX-License-Identifier: AGPL-3.0-or-later\n// Copyright (c) 2026 Notestead contributors\n'],
		['the header alone', `// ${header}\n// Copyright (c) 2026 Notestead contributors\n`],
		['the copyright line alone', 'Copyright (c) 2001-2009 Fixture Holder\n'],
		['the header quoted inside a sentence', `It says "${header}".\nCopyright (c) 2001-2009 Fixture Holder\n`],
		['another holder', `${header}\nCopyright (c) 2001-2009 Fixture Holder and friends\n`],
	])('does not flag %s', (_label, content) => {
		expect(hasUpstreamLicenceHeader(content, licence)).toBe(false);
	});

	test('scans tracked files of any size only, and reads the licence from a git tree', () => {
		const upstream = gitRepo({ LICENSE: licenceText });
		expect(upstreamLicence(upstream.dir, upstream.commit)).toEqual(licence);
		const repo = gitRepo({
			'.gitignore': 'ignored/\n',
			'src/copied.ts': `// ${header}\n// Copyright (c) 2001-2009 Fixture Holder\nexport {};\n`,
			'src/ours.ts': '// SPDX-License-Identifier: AGPL-3.0-or-later\nexport {};\n',
		});
		writeFiles(repo.dir, { 'ignored/copied.ts': `// ${header}\n// Copyright (c) 2001-2009 Fixture Holder\n`, 'untracked.ts': `// ${header}\n// Copyright (c) 2001 Fixture Holder\n` });
		expect(findLicenceHeaders(repo.dir, licence)).toEqual(['src/copied.ts']);
		git(repo.dir, ['add', 'untracked.ts']);
		expect(findLicenceHeaders(repo.dir, licence)).toEqual(['src/copied.ts', 'untracked.ts']);
	});
});
