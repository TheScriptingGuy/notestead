// M1-AC12 (static responses: COOP/COEP, wasm type, cache/transform headers, ETag + 304, compression, non-root,
// read-only rootfs) and the image half of M1-AC28: the image is built from the dist that `web-build import` installed
// (globalSetup), and must serve exactly the files of that artifact's bundle-manifest.json. ADR-0006, ADR-0008.
// No Joplin Server is needed: the proxy upstream points at an unused address.
// Test plan: docs/test-plans/M1-S4.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { cacheableBy, cacheDirectives, headerValue, request } from '../support/http.ts';
import type { HttpResponse } from '../support/http.ts';
import { createStack, ipOf, podman, teardownStack, webImageInfo } from '../support/podman.ts';
import type { Stack } from '../support/podman.ts';
import { startWeb, webEnvFor } from '../support/services.ts';
import type { Web } from '../support/services.ts';

const readDist = (dir: string): Map<string, Buffer> => {
	const files = new Map<string, Buffer>();
	const walk = (d: string): void => {
		for (const entry of readdirSync(d).sort()) {
			const p = join(d, entry);
			if (statSync(p).isDirectory()) walk(p);
			else files.set(relative(dir, p).split(sep).join('/'), readFileSync(p));
		}
	};
	walk(dir);
	return files;
};

const expectNoCacheNoTransform = (res: HttpResponse, what: string): void => {
	const value = headerValue(res.headers, 'cache-control');
	const directives = cacheDirectives(value);
	expect({ what, noCache: directives.has('no-cache'), noTransform: directives.has('no-transform'), cacheable: cacheableBy(value) })
		.toEqual({ what, noCache: true, noTransform: true, cacheable: [] });
};

describe('M1-S4 static bundle responses of the web image (M1-AC12, M1-AC28 image)', () => {
	let stack: Stack | undefined;
	let web: Web;
	let corp: Web;
	let dist: Map<string, Buffer>;
	let staticPaths: string[];

	beforeAll(async () => {
		const info = webImageInfo();
		dist = readDist(info.dist);
		staticPaths = ['index.html', 'environment.js', ...[...dist.keys()].filter(p => p.endsWith('.bundle.js'))];
		stack = createStack('static');
		const unused = `http://${ipOf(stack, 99)}:22300`;
		web = await startWeb(stack, { role: 'web', host: 20, env: webEnvFor(unused) });
		corp = await startWeb(stack, { role: 'web-corp', host: 21, env: webEnvFor(unused, { COEP: 'require-corp' }) });
	});

	afterAll(() => teardownStack(stack));

	it('ac12-s1: / and every static file carry COOP same-origin, COEP credentialless (default), nosniff and no-referrer', async () => {
		expect(dist.has('serviceWorker.bundle.js')).toBe(true);
		for (const path of ['/', ...staticPaths.map(p => `/${p}`)]) {
			const res = await request({ port: web.port, path });
			expect({
				path,
				status: res.status,
				coop: headerValue(res.headers, 'cross-origin-opener-policy'),
				coep: headerValue(res.headers, 'cross-origin-embedder-policy'),
				nosniff: headerValue(res.headers, 'x-content-type-options'),
				referrer: headerValue(res.headers, 'referrer-policy'),
			}).toEqual({ path, status: 200, coop: 'same-origin', coep: 'credentialless', nosniff: 'nosniff', referrer: 'no-referrer' });
		}
		const root = await request({ port: web.port, path: '/' });
		expect(root.body.equals(dist.get('index.html') ?? Buffer.alloc(0))).toBe(true);
	});

	it('ac12-s2: COEP follows $COEP (require-corp), so the value is configuration, not hard-coded', async () => {
		for (const path of ['/', '/app.bundle.js']) {
			const res = await request({ port: corp.port, path });
			expect({ path, coep: headerValue(res.headers, 'cross-origin-embedder-policy'), coop: headerValue(res.headers, 'cross-origin-opener-policy') })
				.toEqual({ path, coep: 'require-corp', coop: 'same-origin' });
		}
	});

	it('ac12-s3: every *.wasm is served as application/wasm', async () => {
		const wasm = [...dist.keys()].filter(p => p.endsWith('.wasm'));
		expect(wasm.length).toBeGreaterThan(0);
		for (const path of wasm) {
			const res = await request({ port: web.port, path: `/${path}` });
			expect({ path, status: res.status, type: headerValue(res.headers, 'content-type') }).toEqual({ path, status: 200, type: 'application/wasm' });
		}
	});

	it('ac12-s4 / ac28-image: the image serves exactly the imported bundle: every file in bundle-manifest.json, byte for byte', async () => {
		const { artifact } = webImageInfo();
		const manifest = JSON.parse(readFileSync(join(artifact, 'bundle-manifest.json'), 'utf8')) as { files: { path: string }[] };
		expect(manifest.files.map(f => f.path).sort()).toEqual([...dist.keys()].sort());
		const mismatched: string[] = [];
		for (const [path, content] of dist) {
			const res = await request({ port: web.port, path: `/${path.split('/').map(encodeURIComponent).join('/')}` });
			if (res.status !== 200 || headerValue(res.headers, 'content-encoding') || !res.body.equals(content)) mismatched.push(`${path} (${res.status})`);
		}
		expect(mismatched).toEqual([]);
	});

	it('ac12-s5: index.html, environment.js, serviceWorker.bundle.js and every *.bundle.js carry Cache-Control: no-cache, no-transform and an ETag', async () => {
		for (const path of staticPaths) {
			const res = await request({ port: web.port, path: `/${path}` });
			expectNoCacheNoTransform(res, path);
			expect({ path, etag: typeof headerValue(res.headers, 'etag') }).toEqual({ path, etag: 'string' });
		}
	});

	it('ac12-s6: Accept-Encoding: zstd, gzip on the app bundle gets a compressed response that decodes to the file', async () => {
		const res = await request({ port: web.port, path: '/app.bundle.js', headers: { 'Accept-Encoding': 'zstd, gzip' } });
		expect(res.status).toBe(200);
		const encoding = headerValue(res.headers, 'content-encoding');
		expect(['zstd', 'gzip']).toContain(encoding);
		const decoded = encoding === 'zstd' ? zstdDecompressSync(res.body) : gunzipSync(res.body);
		expect(decoded.equals(dist.get('app.bundle.js') ?? Buffer.alloc(0))).toBe(true);
		expect(res.body.length).toBeLessThan(decoded.length);
		expectNoCacheNoTransform(res, 'app.bundle.js (compressed)');
		expect(typeof headerValue(res.headers, 'etag')).toBe('string');
	});

	it('ac12-neg: a conditional request with the returned ETag gets 304, and no response carries max-age > 0', async () => {
		for (const [path, encoding] of [...staticPaths.map(p => [p, undefined] as const), ['app.bundle.js', 'zstd, gzip'] as const]) {
			const headers: Record<string, string> = encoding ? { 'Accept-Encoding': encoding } : {};
			const first = await request({ port: web.port, path: `/${path}`, headers });
			const etag = headerValue(first.headers, 'etag') ?? '';
			const again = await request({ port: web.port, path: `/${path}`, headers: { ...headers, 'If-None-Match': etag } });
			expect({ path, encoding, etag: etag !== '', status: again.status }).toEqual({ path, encoding, etag: true, status: 304 });
			for (const res of [first, again]) expect({ path, cacheable: cacheableBy(headerValue(res.headers, 'cache-control')) }).toEqual({ path, cacheable: [] });
		}
	});

	it('ac12-s7: the image runs as a non-root uid with a read-only root filesystem (ADR-0006 hardening as run here)', () => {
		const { image } = webImageInfo();
		const user = podman(['image', 'inspect', '--format', '{{.Config.User}}', image]).stdout.trim();
		expect(user).not.toBe('');
		expect(user.split(':')[0]).not.toMatch(/^(0|root)$/);
		const uids = podman(['top', web.name, 'uid']).stdout.trim().split('\n').slice(1).map(l => l.trim()).filter(l => l !== '');
		expect(uids.length).toBeGreaterThan(0);
		expect(uids.filter(uid => uid === '0')).toEqual([]);
		expect(podman(['inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', web.name]).stdout.trim()).toBe('true');
	});
});
