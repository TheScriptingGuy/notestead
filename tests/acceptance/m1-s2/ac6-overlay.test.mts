// M1-AC6: `corepack yarn workspace web-build overlay <dist>` applies packages/web-build/overlay.json to a built dist/
// in place: environment.js sets __DEV__ = false, manifest.json uses our name and icons, screenshots are removed,
// source.html is generated and the CSP <meta> in index.html stays byte-identical to upstream.
// NEG: a fixture dist/ without environment.js makes the overlay fail, naming the missing file.
// Fixtures: F1 synthetic (offline) and F2 = upstream public/ at web.commit + synthetic webpack outputs (generated at
// test time, never committed). One overlay run per fixture in `before`; the tests only read its result.
// Test plan: docs/test-plans/M1-S2.md.
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertExitNonZero, assertExitZero, assertOutputIncludes, describeRun, readJson, readPin, removeDir } from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';
import { sha256, upstreamIconHashes } from '../support/upstream.mts';
import {
	attempt, cspMetas, hashesOf, headCommit, localRefs, materialize, officialName, officialShortName, overlayJsonPath, probeEnvironment,
	probeOrigins, readTree, scriptTags, settled, syntheticBundle, upstreamPublicBundle, webBuild, webpackOutputPaths,
} from '../support/webBundle.mts';
import type { Attempt, Tree } from '../support/webBundle.mts';

interface OverlayRule {
	path?: unknown;
	action?: unknown;
}

const normalizeRulePath = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '');

const readRules = (): { path: string; action: string }[] => {
	assert.ok(existsSync(overlayJsonPath), 'M1-S2 contract: packages/web-build/overlay.json must exist (docs/test-plans/M1-S2.md §overlay.json)');
	const data = readJson<{ rules?: OverlayRule[] }>(overlayJsonPath);
	assert.ok(Array.isArray(data.rules) && data.rules.length > 0, 'overlay.json must have a non-empty "rules" array');
	return data.rules.map((rule, i) => {
		assert.ok(typeof rule.path === 'string' && rule.path !== '', `overlay.json rules[${i}].path must be a non-empty string`);
		assert.ok(typeof rule.action === 'string' && rule.action !== '', `overlay.json rules[${i}].action must be a non-empty string`);
		return { path: normalizeRulePath(rule.path), action: rule.action };
	});
};

// Rules whose target must already exist in dist/ (every action except "generate").
const mustExistTargets = (): string[] => readRules().filter(r => r.action !== 'generate').map(r => r.path);

const coversPath = (targets: string[], path: string): boolean => targets.some(t => t === path || t.startsWith(`${path}/`));

describe('M1-AC6 overlay.json is declarative and covers the ADR-0010 targets', () => {
	it('T40 overlay.json parses and every rule has a path and an action', () => {
		readRules();
	});

	it('T41 rules cover environment.js, manifest.json, the three HTML pages, icons and screenshots, and generate source.html', () => {
		const rules = readRules();
		const targets = mustExistTargets();
		for (const path of ['environment.js', 'manifest.json', 'index.html', 'just-one-client.html', 'closed.html', 'icons', 'screenshots']) {
			assert.ok(coversPath(targets, path), `overlay.json has no must-exist rule for ${path}; rules: ${JSON.stringify(rules)}`);
		}
		assert.ok(rules.some(r => r.path === 'source.html' && r.action === 'generate'), `overlay.json must generate source.html; rules: ${JSON.stringify(rules)}`);
	});
});

const variants: { id: string; label: string; make: () => Tree; upstream: boolean }[] = [
	{ id: 'F1', label: 'synthetic fixture dist', make: syntheticBundle, upstream: false },
	{ id: 'F2', label: 'upstream public/ at web.commit', make: upstreamPublicBundle, upstream: true },
];

for (const variant of variants) {
	describe(`M1-AC6 overlay on ${variant.id} (${variant.label})`, () => {
		let input: Tree = new Map();
		let dir = '';
		let setup: Attempt<{ result: RunResult; output: Tree }> | null = null;

		before(() => {
			setup = attempt(() => {
				input = variant.make();
				dir = materialize(`m1s2-ac6-${variant.id}`, input);
				const result = webBuild(`T50-${variant.id}-overlay`, 'overlay', [dir]);
				return { result, output: result.code === 0 ? readTree(dir) : new Map<string, Buffer>() };
			});
		});

		after(() => {
			if (dir) removeDir(dir);
		});

		// Every assertion below starts from a successful overlay run.
		const overlaid = (): Tree => {
			const { result, output } = settled(setup);
			assertExitZero(result);
			return output;
		};
		const textOf = (tree: Tree, path: string): string => {
			const content = tree.get(path);
			assert.ok(content, `${path} is missing from the overlaid dist`);
			return content.toString('utf8');
		};

		it(`T50-${variant.id} overlay exits 0`, () => {
			overlaid();
		});

		it(`T51-${variant.id} environment.js sets __DEV__ = false on every origin and keeps the shims`, () => {
			const code = textOf(overlaid(), 'environment.js');
			// Negative control: the input bundle runs in dev mode on localhost, so the probe can see the difference.
			assert.equal(probeEnvironment(textOf(input, 'environment.js'), 'http://localhost:8080').dev, true, 'input environment.js must be dev mode on localhost');
			for (const origin of probeOrigins) {
				const probe = probeEnvironment(code, origin);
				assert.equal(probe.dev, false, `__DEV__ must be exactly false on ${origin}, got ${String(probe.dev)}`);
				assert.equal(probe.exportsType, 'object', `window.exports shim kept (${origin})`);
				assert.equal(probe.expoOs, 'web', `window.process.env.EXPO_OS shim kept (${origin})`);
				assert.equal(probe.title, 'probe-title', `environment.js must not change document.title (${origin})`);
			}
		});

		it(`T52-${variant.id} manifest.json uses our name and our icons, keeps start_url/display and has no screenshots`, () => {
			const tree = overlaid();
			const manifest = JSON.parse(textOf(tree, 'manifest.json')) as Record<string, unknown>;
			assert.equal(manifest.name, officialName);
			assert.equal(manifest.short_name, officialShortName);
			assert.equal(manifest.start_url, './');
			assert.equal(manifest.display, 'standalone');
			assert.ok(!('screenshots' in manifest), 'manifest.json must not list screenshots');

			const strings: string[] = [];
			const collect = (value: unknown): void => {
				if (typeof value === 'string') strings.push(value);
				else if (Array.isArray(value)) value.forEach(collect);
				else if (value && typeof value === 'object') Object.values(value).forEach(collect);
			};
			collect(manifest);
			for (const s of strings) {
				if (/joplin/i.test(s)) assert.equal(s, officialName, `manifest.json mentions Joplin outside our name: ${JSON.stringify(s)}`);
			}

			const icons = manifest.icons as { src?: string; type?: string; sizes?: string }[];
			assert.ok(Array.isArray(icons) && icons.length > 0, 'manifest.json icons must be a non-empty array');
			for (const size of ['64x64', '192x192', '256x256', '512x512']) {
				assert.ok(icons.some(i => i.type === 'image/png' && i.sizes === size), `manifest.json needs a ${size} PNG icon (ADR-0010)`);
			}
			assert.ok(icons.some(i => i.type === 'image/svg+xml'), 'manifest.json needs an SVG icon (ADR-0010)');
			const inputIconHashes = hashesOf(new Map([...input].filter(([p]) => p.startsWith('icons/'))));
			const upstreamHashes = variant.upstream ? upstreamIconHashes() : new Map<string, string>();
			for (const icon of icons) {
				assert.ok(typeof icon.src === 'string' && icon.src.startsWith('./'), `icon src must be relative: ${JSON.stringify(icon)}`);
				const path = icon.src.slice(2);
				const content = tree.get(path);
				assert.ok(content, `manifest icon ${icon.src} does not exist in the overlaid dist`);
				const hash = sha256(content);
				assert.ok(!inputIconHashes.has(hash), `manifest icon ${icon.src} is the input's ${inputIconHashes.get(hash)}`);
				assert.ok(!upstreamHashes.has(hash), `manifest icon ${icon.src} is upstream's ${upstreamHashes.get(hash)}`);
			}
		});

		it(`T53-${variant.id} screenshots are removed`, () => {
			const tree = overlaid();
			assert.ok(![...tree.keys()].some(p => p.startsWith('screenshots/')), 'screenshots/ must be gone');
			const screenshotHashes = hashesOf(new Map([...input].filter(([p]) => p.startsWith('screenshots/'))));
			assert.ok(screenshotHashes.size > 0, 'the fixture must contain screenshots for this test to mean anything');
			for (const [path, content] of tree) {
				assert.ok(!screenshotHashes.has(sha256(content)), `${path} is the input's ${screenshotHashes.get(sha256(content))}`);
			}
		});

		it(`T54-${variant.id} source.html is generated with the upstream repo and commit, our commit and the licence`, () => {
			const html = textOf(overlaid(), 'source.html');
			const { web } = readPin();
			assert.ok(!input.has('source.html'), 'fixture sanity: source.html must not pre-exist');
			assert.ok(html.includes(web.commit), `source.html must state the upstream commit ${web.commit}`);
			assert.ok(html.includes(web.repo.replace(/\.git$/, '')), `source.html must name the upstream repo ${web.repo}`);
			const hrefs = [...html.matchAll(/\bhref\s*=\s*"([^"]*)"/gi)].map(m => m[1]);
			assert.ok(hrefs.some(h => h.includes(web.commit)), `source.html must link the exact upstream commit; hrefs: ${JSON.stringify(hrefs)}`);
			assert.ok(html.includes(headCommit()), `source.html must state our commit (git rev-parse HEAD = ${headCommit()})`);
			assert.match(html, /AGPL-3\.0/, 'source.html must name the AGPL-3.0 licence');
		});

		it(`T55-${variant.id} the CSP <meta> and the script tags in index.html are byte-identical to the input`, () => {
			const inputHtml = textOf(input, 'index.html');
			const outputHtml = textOf(overlaid(), 'index.html');
			const expected = cspMetas(inputHtml);
			assert.equal(expected.length, 1, 'fixture sanity: one CSP meta');
			assert.deepEqual(cspMetas(outputHtml), expected, `the CSP <meta> must be unchanged${variant.upstream ? ' from upstream' : ''}`);
			assert.deepEqual(scriptTags(outputHtml), scriptTags(inputHtml), 'script tags must be unchanged (ADR-0010)');
		});

		it(`T56-${variant.id} webpack outputs are untouched and no page references a missing file`, () => {
			const tree = overlaid();
			for (const path of webpackOutputPaths) {
				assert.ok(tree.get(path)?.equals(input.get(path) ?? Buffer.alloc(0)), `${path} must be byte-identical after the overlay`);
			}
			for (const page of ['index.html', 'closed.html', 'just-one-client.html', 'source.html']) {
				for (const ref of localRefs(textOf(tree, page))) assert.ok(tree.has(ref), `${page} references ./${ref}, which the overlaid dist lacks`);
			}
		});
	});
}

describe('M1-AC6 NEG: missing expected files fail the overlay, naming the file', () => {
	const temps: string[] = [];
	after(() => temps.forEach(removeDir));

	const withoutPath = (label: string, path: string): RunResult => {
		const dir = materialize(`m1s2-ac6-neg-${label}`, syntheticBundle());
		temps.push(dir);
		rmSync(join(dir, ...path.split('/')), { recursive: true, force: false });
		return webBuild(`T6x-overlay-without-${label}`, 'overlay', [dir]);
	};

	it('T60 (AC NEG) F1 without environment.js fails and names environment.js; positive control is T50-F1', () => {
		const r = withoutPath('environment.js', 'environment.js');
		assertExitNonZero(r);
		assertOutputIncludes(r, 'environment.js', 'the overlay must name the missing file');
	});

	it('T61 F1 without any other must-exist target of overlay.json fails, naming that target', () => {
		const targets = [...new Set(mustExistTargets())].filter(t => t !== 'environment.js');
		assert.ok(targets.length >= 5, `expected the ADR-0010 targets in overlay.json, got ${JSON.stringify(targets)}`);
		const problems: string[] = [];
		for (const target of targets) {
			const r = withoutPath(target.replace(/\//g, '_'), target);
			if (r.code === 0 || r.code === null || !r.output.includes(target)) problems.push(`without ${target}: ${describeRun(r)}`);
		}
		assert.deepEqual(problems, [], `the overlay must fail loudly and name each missing target:\n${problems.join('\n\n')}`);
	});
});
