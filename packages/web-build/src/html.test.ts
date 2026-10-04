import { cspMetas, escapeHtml, insertBefore, localRefs, setMeta, setTitle } from './html.ts';
import { csp } from './testing/fixtures.ts';

const html = `<html>\n\t<head>\n\t\t${csp}\n\t\t<meta\n\t\t\tname="description"\n\t\t\tcontent="old"\n\t\t/>\n\t\t<title>Old</title>\n\t</head>\n\t<body>\n\t</body>\n</html>\n`;

describe('html', () => {
	test('escapes text and attribute values', () => {
		expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
	});

	test('replaces the single title and fails when there is none or more than one', () => {
		expect(setTitle(html, 'New & $& better')).toContain('<title>New &amp; $&amp; better</title>');
		expect(() => setTitle('<head></head>', 'x')).toThrow('expected exactly one <title> element, found 0');
		expect(() => setTitle('<title>a</title><title>b</title>', 'x')).toThrow('found 2');
	});

	test('replaces a multi-line meta element, or adds a missing one before </head>, leaving the CSP byte-identical', () => {
		const replaced = setMeta(html, { name: 'description', content: 'new "quoted"' }, '\t\t');
		expect(replaced).toContain('<meta name="description" content="new &quot;quoted&quot;"/>');
		expect(replaced).not.toContain('content="old"');
		const added = setMeta(replaced, { property: 'og:description', content: 'og' }, '\t\t');
		expect(added).toContain('\t\t<meta property="og:description" content="og"/>\n\t</head>');
		expect(cspMetas(added)).toEqual([csp]);
	});

	test('inserts lines before the single closing tag and fails on a missing or duplicated anchor', () => {
		expect(insertBefore(html, '</body>', ['<a href="./x">x</a>'], '\t\t')).toContain('\t<body>\n\t\t<a href="./x">x</a>\n\t</body>');
		expect(() => insertBefore('<html></html>', '</body>', ['x'], '')).toThrow('expected exactly one </body>, found 0');
	});

	test('lists same-directory references only', () => {
		expect(localRefs('<link href="./a.css"/><img src="./i/b.png?x"/><a href="./">app</a><a href="https://x/y">y</a>')).toEqual(['a.css', 'i/b.png']);
	});
});
