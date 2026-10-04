// M1-S2 harness self-checks: prove the fixtures and probes used by the AC5-AC7 tests can tell good from bad, so a
// broken harness cannot pass as a correct result. These pass before the feature exists (RED shows only AC tests).
// Test plan: docs/test-plans/M1-S2.md.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readPin } from '../support/repo.mts';
import { sha256, upstreamIconHashes, upstreamIcons, upstreamPublicFiles } from '../support/upstream.mts';
import { cspMetas, localRefs, probeEnvironment, scriptTags, syntheticBundle, upstreamPublicBundle } from '../support/webBundle.mts';

describe('M1-S2 harness self-checks', () => {
	it('H1 the upstream icon set at web.commit is derived, non-empty and distinct', () => {
		const icons = upstreamIcons();
		assert.ok(icons.size >= 6, `expected at least 6 upstream icons at ${readPin().web.commit}, got ${[...icons.keys()].join(', ')}`);
		for (const name of ['icons/icon-64.png', 'icons/icon-192.png', 'icons/icon-256.png', 'icons/icon-512.png', 'icons/icon-vector-large.svg']) {
			assert.ok(icons.has(name), `upstream icon ${name} missing from the derived set`);
		}
		assert.equal(upstreamIconHashes().size, icons.size, 'upstream icons must have distinct sha256 values');
	});

	it('H2 the environment.js probe sees dev mode on localhost and not elsewhere (upstream and synthetic)', () => {
		for (const [label, code] of [
			['upstream', upstreamPublicFiles().get('environment.js')?.toString('utf8')],
			['synthetic', syntheticBundle().get('environment.js')?.toString('utf8')],
		] as const) {
			assert.ok(code, `${label} environment.js missing`);
			assert.equal(probeEnvironment(code, 'http://localhost:8080').dev, true, `${label}: localhost must be dev mode before the overlay`);
			assert.equal(probeEnvironment(code, 'https://notes.example.com').dev, false, `${label}: other origins are not dev mode`);
			const probe = probeEnvironment(code, 'https://notes.example.com');
			assert.equal(probe.exportsType, 'object', `${label}: window.exports shim`);
			assert.equal(probe.expoOs, 'web', `${label}: window.process.env.EXPO_OS shim`);
		}
	});

	it('H3 the CSP probe finds exactly one CSP <meta> and detects a one-byte change', () => {
		for (const [label, html] of [
			['upstream', upstreamPublicFiles().get('index.html')?.toString('utf8')],
			['synthetic', syntheticBundle().get('index.html')?.toString('utf8')],
		] as const) {
			assert.ok(html, `${label} index.html missing`);
			const metas = cspMetas(html);
			assert.equal(metas.length, 1, `${label}: expected one CSP meta`);
			assert.match(metas[0], /default-src 'self'/, `${label}: the CSP meta was captured whole`);
			const mutated = html.replace("default-src 'self'", "default-src  'self'");
			assert.notEqual(cspMetas(mutated)[0], metas[0], `${label}: a whitespace change in the CSP must be visible`);
			assert.ok(scriptTags(html).length >= 2, `${label}: script tags captured`);
		}
	});

	it('H4 the synthetic fixture contains no upstream content', () => {
		const upstreamHashes = new Set([...upstreamPublicFiles().values()].map(c => sha256(c)));
		for (const [path, content] of syntheticBundle()) {
			assert.ok(!upstreamHashes.has(sha256(content)), `synthetic ${path} equals an upstream file`);
		}
	});

	it('H5 every local reference in the un-overlaid pages resolves (baseline for the dangling-reference check)', () => {
		for (const [label, tree] of [['upstream', upstreamPublicBundle()], ['synthetic', syntheticBundle()]] as const) {
			for (const page of ['index.html', 'closed.html', 'just-one-client.html']) {
				const html = tree.get(page)?.toString('utf8');
				assert.ok(html, `${label} ${page} missing`);
				for (const ref of localRefs(html)) assert.ok(tree.has(ref), `${label} ${page} references ./${ref}, which the fixture lacks`);
			}
		}
	});
});
