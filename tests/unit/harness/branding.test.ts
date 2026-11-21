// The branding checkers of the M2-S6 tests (tests/support/branding.ts; docs/test-plans/M2-S6.md, AC table "checkers"). Each
// checker has a passing and a failing input, built from synthetic strings (no upstream bytes). They are the eyes of the E2E
// tests M2-AC11/12 and of the file-level tests U-AC11: the un-overlaid NEGs prove they see upstream's branding, these prove
// the checkers themselves tell a good page from a bad one.
import { describe, expect, test } from '@jest/globals';
import {
	htmlBrandingProblems, iconRefs, manifestBrandingProblems, manifestIconRefs, metaContents, notAffiliated, ourRepoUrl, productName,
	productShortName, titleOf, upstreamHashHits,
} from '../../support/branding.ts';

const notice = `Notestead for Joplin (unofficial): a self-hosted web build. Not affiliated with or endorsed by JOPLIN SAS.`;

const page = (head: string): string => `<!DOCTYPE html>\n<html>\n<head>\n${head}\n</head>\n<body></body>\n</html>\n`;

const goodIndex = page([
	`<meta charset="utf-8"/>`,
	`<link rel="icon" href="./icons/icon-vector-large.svg"/>`,
	`<link rel="apple-touch-icon" href="./icons/icon-192.png"/>`,
	`<meta name="description" content="${notice}"/>`,
	`<meta property="og:description" content="${notice}"/>`,
	`<meta property="og:image" content="./icons/icon-192.png"/>`,
	`<title>${productName}</title>`,
].join('\n'));

const goodClosed = page([
	`<link rel="icon" href="./icons/icon-vector-large.svg"/>`,
	`<title>Closed - ${productName}</title>`,
	`<meta name="description" content="${notice}"/>`,
].join('\n'));

const goodManifest = {
	short_name: productShortName,
	name: productName,
	icons: [
		{ src: './icons/icon-vector-large.svg', type: 'image/svg+xml', sizes: 'any' },
		{ src: './icons/icon-512.png', type: 'image/png', sizes: '512x512' },
		{ src: './icons/icon-192.png', type: 'image/png', sizes: '192x192' },
	],
};

describe('branding checkers', () => {
	test('br-01 titleOf lists every title, entity-decoded, across lines', () => {
		expect(titleOf(goodIndex)).toEqual([productName]);
		expect(titleOf(page('<title>A &amp; B &lt;c&gt;</title><title>\n  second\n</title>'))).toEqual(['A & B <c>', 'second']);
		expect(titleOf(page('<meta charset="utf-8"/>'))).toEqual([]);
	});

	test('br-02 metaContents finds name= and property= in any attribute order and across lines', () => {
		const html = page([
			'<meta name="description" content="one"/>',
			'<meta content="two" name="description"/>',
			'<meta\n\tproperty="og:description"\n\tcontent="three"\n/>',
			'<meta content="four" property="og:image">',
		].join('\n'));
		expect(metaContents(html, 'description')).toEqual(['one', 'two']);
		expect(metaContents(html, 'og:description')).toEqual(['three']);
		expect(metaContents(html, 'og:image')).toEqual(['four']);
		expect(metaContents(html, 'keywords')).toEqual([]);
	});

	test('br-03 iconRefs reads the rel tokens icon and apple-touch-icon, shortcut icon and og:image, and nothing else', () => {
		const html = page([
			'<link rel="icon" href="./icons/a.svg"/>',
			'<link rel="apple-touch-icon" href="./icons/b.png"/>',
			'<link rel="shortcut icon" href="/favicon.ico"/>',
			'<link href="https://example.test/c.png" rel="ICON"/>',
			'<link rel="stylesheet" href="./x.css"/>',
			'<link rel="license" href="./source.html"/>',
			'<link rel="manifest" href="./manifest.json"/>',
			'<meta property="og:image" content="./icons/d.png"/>',
			'<meta name="description" content="./not-an-icon.png"/>',
		].join('\n'));
		const refs = iconRefs(html);
		expect(refs.map(r => r.href)).toEqual(['./icons/a.svg', './icons/b.png', '/favicon.ico', 'https://example.test/c.png', './icons/d.png']);
		expect(refs.map(r => r.rel)).toEqual(['icon', 'apple-touch-icon', 'shortcut icon', 'ICON', 'og:image']);
		expect(iconRefs(page('<title>none</title>'))).toEqual([]);
	});

	test('br-04 manifestIconRefs returns src, type and sizes of every icon, and [] without icons', () => {
		expect(manifestIconRefs(goodManifest)).toEqual([
			{ src: './icons/icon-vector-large.svg', type: 'image/svg+xml', sizes: 'any' },
			{ src: './icons/icon-512.png', type: 'image/png', sizes: '512x512' },
			{ src: './icons/icon-192.png', type: 'image/png', sizes: '192x192' },
		]);
		expect(manifestIconRefs({ name: 'x' })).toEqual([]);
		expect(manifestIconRefs({ icons: [{ src: './a.png' }] })).toEqual([{ src: './a.png', type: '', sizes: '' }]);
	});

	test('br-05 htmlBrandingProblems accepts our index page and names each problem of an upstream-like one', () => {
		expect(htmlBrandingProblems('index', goodIndex)).toEqual([]);
		const upstreamLike = page([
			'<title>Joplin</title>',
			'<meta name="description" content="Joplin Web, the open source note-taking app"/>',
			'<meta property="og:description" content="Joplin Web"/>',
		].join('\n'));
		const problems = htmlBrandingProblems('index', upstreamLike).join('\n');
		expect(problems).toMatch(/title/i);
		expect(problems).toMatch(/description/i);
		expect(problems).toMatch(/og:description/);
	});

	test('br-06 htmlBrandingProblems checks closed and just-one-client: two titles, a stray Joplin and a missing notice fail', () => {
		expect(htmlBrandingProblems('closed', goodClosed)).toEqual([]);
		expect(htmlBrandingProblems('just-one-client', goodClosed.replace('Closed - ', 'Error - '))).toEqual([]);
		// JOPLIN SAS in a title is allowed; Joplin outside the product name is not
		expect(htmlBrandingProblems('closed', goodClosed.replace(`Closed - ${productName}`, `Closed - ${productName} (JOPLIN SAS)`))).toEqual([]);
		expect(htmlBrandingProblems('closed', goodClosed.replace(`Closed - ${productName}`, `Closed - ${productName} - Joplin`)).join('\n')).toMatch(/Joplin/);
		expect(htmlBrandingProblems('closed', `${goodClosed}<title>Joplin</title>`).join('\n')).toMatch(/exactly one/i);
		expect(htmlBrandingProblems('closed', goodClosed.replace(/Not affiliated with or endorsed by JOPLIN SAS\./, '')).join('\n')).toMatch(/notice|affiliated/i);
		expect(htmlBrandingProblems('closed', page(`<title>Closed - ${productName}</title>`)).join('\n')).toMatch(/description/i);
		expect(notAffiliated.some(p => p.test('Not Affiliated with x'))).toBe(true);
		expect(notAffiliated.every(p => p.test('Not affiliated with or endorsed by JOPLIN SAS'))).toBe(true);
	});

	test('br-07 manifestBrandingProblems checks the names, the screenshots and the 192 and 512 PNG icons', () => {
		expect(manifestBrandingProblems(goodManifest)).toEqual([]);
		const bad = manifestBrandingProblems({
			short_name: 'Joplin', name: 'Joplin Web', screenshots: [{ src: './screenshots/tall.png' }],
			icons: [{ src: './icons/icon-64.png', type: 'image/png', sizes: '64x64' }, { src: './icons/icon-512.svg', type: 'image/svg+xml', sizes: '512x512' }],
		}).join('\n');
		expect(bad).toMatch(/name/);
		expect(bad).toMatch(/short_name/);
		expect(bad).toMatch(/screenshots/);
		expect(bad).toMatch(/192x192/);
		expect(bad).toMatch(/512x512/);
		expect(manifestBrandingProblems({ ...goodManifest, icons: [] }).join('\n')).toMatch(/192x192/);
	});

	test('br-08 upstreamHashHits names each entry whose sha256 is in the set and the upstream path it equals', () => {
		const hashes = new Map([['a'.repeat(64), 'icons/icon-large.png'], ['b'.repeat(64), 'screenshots/tall.png']]);
		const entries = [
			{ path: '/icons/icon-192.png', sha256: 'c'.repeat(64) },
			{ path: '/icons/icon-large.png', sha256: 'a'.repeat(64) },
			{ path: '/favicon.ico', sha256: 'a'.repeat(64) },
		];
		expect(upstreamHashHits(entries, hashes)).toEqual([
			{ path: '/icons/icon-large.png', upstreamPath: 'icons/icon-large.png' },
			{ path: '/favicon.ico', upstreamPath: 'icons/icon-large.png' },
		]);
		expect(upstreamHashHits(entries, new Map())).toEqual([]);
		expect(upstreamHashHits([], hashes)).toEqual([]);
	});

	test('br-09 ourRepoUrl defaults to the Notestead repository and takes NOTESTEAD_SOURCE_REPO without a trailing slash or .git', () => {
		expect(ourRepoUrl({})).toBe('https://github.com/TheScriptingGuy/notestead');
		expect(ourRepoUrl({ NOTESTEAD_SOURCE_REPO: 'https://example.test/me/repo.git' })).toBe('https://example.test/me/repo');
		expect(ourRepoUrl({ NOTESTEAD_SOURCE_REPO: 'https://example.test/me/repo/' })).toBe('https://example.test/me/repo');
		expect(productName).toBe('Notestead for Joplin (unofficial)');
		expect(productShortName).toBe('Notestead');
	});
});
