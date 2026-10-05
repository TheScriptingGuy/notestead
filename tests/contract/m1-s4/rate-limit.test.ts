// M1-AC11: the server's login limiter (10 requests/min per X-Real-IP) behind the proxy, on a real joplin/server
// WITHOUT JOPLIN_IS_TESTING (the limiter is active). ADR-0002 rule 4; spike S2 R1–R3, spike S6 T3/T4.
// Each test uses its own limiter keys (client addresses, CF-Connecting-IP values), so tests are independent.
// Test plan: docs/test-plans/M1-S4.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../support/http.ts';
import { createStack, ipOf, podman, runClient, teardownStack, webImageInfo } from '../support/podman.ts';
import type { ClientRequest, Stack } from '../support/podman.ts';
import { startJoplinServer, startWeb, user1, webEnvFor } from '../support/services.ts';
import type { JoplinServer, Web } from '../support/services.ts';

const cloudflared = 10;
const otherPeer = 11;
const clientA = 50;
const clientB = 51;
const clientC = 52;

const loginRequest = (web: Web, password: string, headers: Record<string, string> = {}): ClientRequest => ({
	method: 'POST',
	url: `http://${web.ip}:8080/joplin-server/api/sessions`,
	headers: { 'Content-Type': 'application/json', ...headers },
	body: JSON.stringify({ email: user1.email, password }),
});

const statuses = (stack: Stack, peer: number, requests: ClientRequest[]): number[] => runClient(stack, peer, requests).map(r => r.status);

const tenRejectedThenLimited = [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 429];

describe('M1-S4 login rate limiting behind the proxy (M1-AC11; server without JOPLIN_IS_TESTING)', () => {
	let stack: Stack | undefined;
	let server: JoplinServer;
	let web: Web;
	let tunnel: Web;

	beforeAll(async () => {
		webImageInfo(); // fail fast, before any container starts
		stack = createStack('ratelimit');
		server = await startJoplinServer(stack, { role: 'server', host: 30, testing: false });
		web = await startWeb(stack, { role: 'web', host: 20, env: webEnvFor(server.url) });
		tunnel = await startWeb(stack, { role: 'web-tunnel', host: 21, env: webEnvFor(server.url, {
			TRUSTED_PROXIES: `${ipOf(stack, cloudflared)}/32`,
			CLIENT_IP_HEADER: 'CF-Connecting-IP',
		}) });
	});

	afterAll(() => teardownStack(stack));

	it('ac11-r1-r2: 11 bad logins from client A get 429 on the 11th despite a new X-Real-IP each time; client B right after gets 200', () => {
		const s = stack as Stack;
		const bad = Array.from({ length: 11 }, (_v, i) => loginRequest(web, 'wrong-password', { 'X-Real-IP': `198.18.0.${i + 1}` }));
		expect(statuses(s, clientA, bad)).toEqual(tenRejectedThenLimited);
		expect(statuses(s, clientB, [loginRequest(web, user1.password)])).toEqual([200]);
	});

	it('ac11-r3-neg: the same image with the X-Real-IP overwrite removed from its Caddyfile never returns 429 to a spoofing client', async () => {
		const s = stack as Stack;
		const { image } = webImageInfo();
		// The image's own Caddyfile, minus every `header_up X-Real-IP …` line: one rule removed, nothing else changed.
		const probe = `nst-ratelimit-caddyfile-${process.pid}`;
		podman(['create', '--name', probe, image]);
		const original = join(s.logsDir, 'Caddyfile.image');
		try {
			podman(['cp', `${probe}:/etc/caddy/Caddyfile`, original]);
		} finally {
			podman(['rm', '-f', probe], { allowFail: true });
		}
		const text = readFileSync(original, 'utf8');
		const overwrite = /^[ \t]*header_up[ \t]+X-Real-IP\b.*(?:\r?\n|$)/gim;
		const removed = text.match(overwrite) ?? [];
		expect(removed.length).toBeGreaterThan(0);
		const variantFile = join(s.logsDir, 'Caddyfile.passthrough');
		writeFileSync(variantFile, text.replace(overwrite, ''));
		const passthrough = await startWeb(s, { role: 'web-passthrough', host: 22, env: webEnvFor(server.url), caddyfile: variantFile });
		// Positive control: the variant is a working proxy.
		expect((await request({ port: passthrough.port, path: '/joplin-server/api/ping' })).status).toBe(200);
		const spoofing = Array.from({ length: 12 }, (_v, i) => loginRequest(passthrough, 'wrong-password', { 'X-Real-IP': `198.51.100.${i + 1}` }));
		expect(statuses(s, clientC, spoofing)).toEqual(Array.from({ length: 12 }, () => 403));
	});

	it('ac11-tunnel: from cloudflared\'s address, 11 bad logins with one CF-Connecting-IP get 429 on the 11th; a 12th with another CF-Connecting-IP gets 200', () => {
		const s = stack as Stack;
		const requests = [
			...Array.from({ length: 11 }, () => loginRequest(tunnel, 'wrong-password', { 'CF-Connecting-IP': '203.0.113.7' })),
			loginRequest(tunnel, user1.password, { 'CF-Connecting-IP': '203.0.113.8' }),
		];
		expect(statuses(s, cloudflared, requests)).toEqual([...tenRejectedThenLimited, 200]);
	});

	it('ac11-r5-neg: from any other container, a CF-Connecting-IP rotated on every request is ignored: 429 on the 11th', () => {
		const s = stack as Stack;
		const rotating = Array.from({ length: 11 }, (_v, i) => loginRequest(tunnel, 'wrong-password', { 'CF-Connecting-IP': `203.0.113.${100 + i}` }));
		expect(statuses(s, otherPeer, rotating)).toEqual(tenRejectedThenLimited);
	});
});
