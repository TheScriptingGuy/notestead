import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cspMetas } from './html.ts';
import { applyOverlay, loadOverlayConfig, parseOverlayConfig } from './overlay.ts';
import type { OverlayConfig } from './overlay.ts';
import { csp, distFixture, removeTempDirs, tempDir, webBuildDir, writeFiles } from './testing/fixtures.ts';
import { hashFiles } from './tree.ts';

const repoConfig = (): OverlayConfig => loadOverlayConfig(join(webBuildDir, 'overlay.json'));
const repoContext = { baseDir: webBuildDir, templates: { sourceOffer: () => '<html><a href="./">app</a></html>\n' } };
const read = (dir: string, path: string): string => readFileSync(join(dir, path), 'utf8');

describe('overlay', () => {
	afterAll(removeTempDirs);

	test('rejects malformed configurations, naming every problem', () => {
		expect(() => parseOverlayConfig({ rules: [] })).toThrow('non-empty "rules" array');
		let message = '';
		try {
			parseOverlayConfig({ rules: [
				{ path: '../escape', action: 'remove' },
				{ path: 'a', action: 'rename' },
				{ path: 'b', action: 'replace' },
				{ path: 'c', action: 'editJson' },
				{ path: 'd', action: 'editHtml', meta: [{ name: 'x', property: 'y', content: 'z' }] },
				{ path: 'e', action: 'generate', source: 'x', template: 'y' },
				{ path: 'a', action: 'remove' },
			] });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message.split('\n')).toEqual([
			expect.stringContaining('rules[0].path'),
			expect.stringContaining('rules[1].action'),
			expect.stringContaining('rules[2].source'),
			expect.stringContaining('rules[3]: editJson needs'),
			expect.stringContaining('rules[4].meta'),
			expect.stringContaining('rules[5]: a generate rule has either'),
			expect.stringContaining('rules[6].path: a has more than one rule'),
		]);
	});

	test('the repository overlay.json applies to an upstream-like dist and leaves the CSP and webpack outputs alone', () => {
		const dist = distFixture();
		const before = new Map(hashFiles(dist).map(file => [file.path, file.sha256]));
		const changes = applyOverlay(dist, repoConfig(), repoContext);
		expect(changes).toContain('generated source.html');

		expect(read(dist, 'environment.js')).toContain('window.__DEV__ = false;');
		const manifest = JSON.parse(read(dist, 'manifest.json'));
		expect(manifest).toMatchObject({ name: 'Notestead for Joplin (unofficial)', short_name: 'Notestead', start_url: './', display: 'standalone' });
		expect(manifest.screenshots).toBeUndefined();
		expect(existsSync(join(dist, 'screenshots'))).toBe(false);
		expect(read(dist, 'icons/icon-vector-large.svg')).toContain('Notestead (placeholder icon)');
		expect(existsSync(join(dist, 'icons', 'icon-512.png'))).toBe(true);

		const index = read(dist, 'index.html');
		expect(cspMetas(index)).toEqual([csp]);
		expect(index).toContain('<title>Notestead for Joplin (unofficial)</title>');
		expect(index).toContain('<link rel="license" href="./source.html"/>');
		expect(index).toMatch(/<a class="notestead-source-link" href="\.\/source\.html" aria-label="[^"]+">Source<\/a>\n\t<\/body>/);
		expect(read(dist, 'closed.html')).toContain('<title>Closed - Notestead for Joplin (unofficial)</title>');
		const after = new Map(hashFiles(dist).map(file => [file.path, file.sha256]));
		for (const path of ['app.bundle.js', 'app.bundle.js.LICENSE.txt']) expect(after.get(path)).toBe(before.get(path));
	});

	test('reports every missing target and changes nothing', () => {
		const dist = distFixture();
		writeFiles(dist, { 'source.html': 'already here' });
		const before = hashFiles(dist);
		let message = '';
		try {
			const config = repoConfig();
			config.rules.push({ path: 'missing.txt', action: 'remove' });
			applyOverlay(dist, config, repoContext);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('(remove missing.txt): missing.txt is missing from');
		expect(message).toContain('(generate source.html): source.html already exists');
		expect(hashFiles(dist)).toEqual(before);
	});

	test('fails on an HTML page without its anchors, naming the page', () => {
		const dist = distFixture();
		writeFiles(dist, { 'closed.html': '<html><body>no head, no title</body></html>' });
		expect(() => applyOverlay(dist, repoConfig(), repoContext)).toThrow(/editHtml closed\.html\): expected exactly one <title> element/);
	});

	test('fails when an edited page would reference a file the overlaid bundle lacks', () => {
		const dist = tempDir('refs');
		writeFiles(dist, { 'index.html': '<html><head><title>x</title></head><body></body></html>', 'icons/a.png': 'a' });
		const config = parseOverlayConfig({ rules: [
			{ path: 'icons', action: 'remove' },
			{ path: 'index.html', action: 'editHtml', head: ['<link rel="icon" href="./icons/a.png"/>'] },
		] });
		expect(() => applyOverlay(dist, config, repoContext)).toThrow('index.html references ./icons/a.png, which the overlaid bundle would not contain');
		expect(existsSync(join(dist, 'icons', 'a.png'))).toBe(true);
	});

	test('names a missing dist and an unknown template', () => {
		const missing = join(tempDir('none'), 'dist');
		expect(() => applyOverlay(missing, repoConfig(), repoContext)).toThrow(`dist ${missing} does not exist`);
		const config = parseOverlayConfig({ rules: [{ path: 'x.html', action: 'generate', template: 'nope' }] });
		expect(() => applyOverlay(distFixture(), config, repoContext)).toThrow('unknown template "nope"');
	});
});
