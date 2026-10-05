// M1-AC10 C9/C10 and the data half of M1-AC11, against an echo upstream in place of the server: exactly what the
// Joplin Server would receive. ADR-0002 rules 3, 4 and 8 (gate 1: Cloudflare Tunnel front, S6).
// - Two web containers of the image under test: the product default (no trusted proxy) and tunnel mode
//   (TRUSTED_PROXIES = the cloudflared stand-in's fixed address, CLIENT_IP_HEADER=CF-Connecting-IP).
// - Fixture clients at fixed addresses: .10 is the cloudflared stand-in, .11 is any other container.
// Test plan: docs/test-plans/M1-S4.md.
import { randomUUID } from 'node:crypto';
import { cacheableBy, cacheDirectives, headerValue, request } from '../support/http.ts';
import { createStack, ipOf, runClient, teardownStack, webImageInfo } from '../support/podman.ts';
import type { ClientRequest, Stack } from '../support/podman.ts';
import { parseEcho, publicHost, startEcho, startWeb, webAppHost, webEnvFor } from '../support/services.ts';
import type { Echo, Echoed, Web } from '../support/services.ts';

const cloudflared = 10;
const otherPeer = 11;

describe('M1-S4 proxy headers seen by the upstream (echo): Access headers, caching, client IP (M1-AC10 C9/C10, M1-AC11)', () => {
	let stack: Stack | undefined;
	let echo: Echo;
	let web: Web;
	let tunnel: Web;

	beforeAll(async () => {
		webImageInfo(); // fail fast, before any container starts
		stack = createStack('headers');
		echo = await startEcho(stack, { role: 'echo', host: 40 });
		web = await startWeb(stack, { role: 'web', host: 20, env: webEnvFor(echo.url) });
		tunnel = await startWeb(stack, { role: 'web-tunnel', host: 21, env: webEnvFor(echo.url, {
			TRUSTED_PROXIES: `${ipOf(stack, cloudflared)}/32`,
			CLIENT_IP_HEADER: 'CF-Connecting-IP',
		}) });
	});

	afterAll(() => teardownStack(stack));

	// Requests from a fixture client container; returns what the upstream received for each.
	const fromPeer = (peer: number, target: Web, requests: { path: string; headers: Record<string, string> }[]): Echoed[] => {
		if (!stack) throw new Error('no stack');
		const plan: ClientRequest[] = requests.map(r => ({ url: `http://${target.ip}:8080/joplin-server/api/${r.path}`, headers: r.headers }));
		return runClient(stack, peer, plan).map((res, i) => {
			expect({ request: requests[i].path, status: res.status }).toEqual({ request: requests[i].path, status: 200 });
			return parseEcho(res.body);
		});
	};

	const realIp = (echoed: Echoed): string[] => echoed.headers['x-real-ip'] ?? [];

	it('ac10-c9: Cf-Access-Jwt-Assertion, Cf-Access-Authenticated-User-Email, Origin, Referer and Cookie are not forwarded; Set-Cookie is not returned', async () => {
		const probe = `probe-${randomUUID()}`;
		const res = await request({ port: web.port, path: '/joplin-server/api/c9-probe', headers: {
			'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJSUzI1NiJ9.m1s4.fixture',
			'Cf-Access-Authenticated-User-Email': 'someone@example.com',
			Origin: `https://${webAppHost}`,
			Referer: `https://${webAppHost}/index.html`,
			Cookie: 'browser-cookie=m1s4',
			'X-Notestead-Probe': probe,
		} });
		expect(res.status).toBe(200);
		const echoed = parseEcho(res.text);
		const forwarded = ['cf-access-jwt-assertion', 'cf-access-authenticated-user-email', 'origin', 'referer', 'cookie'].filter(h => echoed.headers[h]);
		expect(forwarded).toEqual([]);
		// Positive controls: other client headers do reach the upstream; the prefix is stripped; Host is rewritten.
		expect(echoed.headers['x-notestead-probe']).toEqual([probe]);
		expect(echoed.url).toBe('/api/c9-probe');
		expect(echoed.headers.host).toEqual([publicHost]);
		expect(headerValue(res.headers, 'set-cookie')).toBeUndefined();
	});

	it('ac10-c10-override: the proxy replaces the upstream\'s cacheable Cache-Control with no-store, no-transform', async () => {
		const upstream = await request({ port: echo.port, path: '/api/c10' });
		expect(headerValue(upstream.headers, 'cache-control')).toBe('public, max-age=3600');
		const res = await request({ port: web.port, path: '/joplin-server/api/c10' });
		expect(res.status).toBe(200);
		const value = headerValue(res.headers, 'cache-control');
		const directives = cacheDirectives(value);
		expect({ noStore: directives.has('no-store'), noTransform: directives.has('no-transform'), cacheable: cacheableBy(value) })
			.toEqual({ noStore: true, noTransform: true, cacheable: [] });
	});

	it('ac11-ip-tunnel: from cloudflared\'s address, X-Real-IP is exactly CF-Connecting-IP (never X-Forwarded-For or a client X-Real-IP)', () => {
		const [withHeader, withoutHeader] = fromPeer(cloudflared, tunnel, [
			{ path: 'ip-1', headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Real-IP': '198.18.7.7', 'X-Forwarded-For': '192.0.2.66' } },
			{ path: 'ip-2', headers: { 'X-Real-IP': '198.18.7.7', 'X-Forwarded-For': '192.0.2.66' } },
		]);
		expect(realIp(withHeader)).toEqual(['203.0.113.7']);
		// Without CF-Connecting-IP the TCP peer is used, not the left part of X-Forwarded-For.
		expect(realIp(withoutHeader)).toEqual([ipOf(stack as Stack, cloudflared)]);
	});

	it('ac11-ip-untrusted (R5 data): from any other peer, CF-Connecting-IP and X-Real-IP are ignored; X-Real-IP is the TCP peer', () => {
		const [echoed] = fromPeer(otherPeer, tunnel, [
			{ path: 'ip-3', headers: { 'CF-Connecting-IP': '203.0.113.8', 'X-Real-IP': '198.18.8.8', 'X-Forwarded-For': '192.0.2.67' } },
		]);
		expect(realIp(echoed)).toEqual([ipOf(stack as Stack, otherPeer)]);
	});

	it('ac11-ip-default: with no trusted proxy configured (the default), even cloudflared\'s address is keyed by its TCP peer', async () => {
		const [echoed] = fromPeer(cloudflared, web, [
			{ path: 'ip-4', headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Real-IP': '198.18.9.9' } },
		]);
		expect(realIp(echoed)).toEqual([ipOf(stack as Stack, cloudflared)]);
		// From the host through the published port: a single X-Real-IP that is not the spoofed value.
		const res = await request({ port: web.port, path: '/joplin-server/api/ip-5', headers: { 'X-Real-IP': '198.18.10.10', 'CF-Connecting-IP': '203.0.113.10' } });
		const fromHost = realIp(parseEcho(res.text));
		expect(fromHost).toHaveLength(1);
		expect(['198.18.10.10', '203.0.113.10']).not.toContain(fromHost[0]);
	});
});
