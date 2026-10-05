// The containers of the M1-S4 contract stacks (docs/test-plans/M1-S4.md §Image contract, §Contract stacks):
// - a throwaway joplin/server at the pinned tag (`node dist/index.js --env dev --env-file /dev/null`, ADR-0007),
//   ready when GET /api/ping says {"status":"ok"}, seeded with createTestUsers;
// - the `web` image under test, run with the ADR-0006 hardening and published :8080/:8089 on 127.0.0.1;
// - an echo upstream (Node) that returns the request it received, in place of the server (M1-AC10 C9, M1-AC11).
import { join } from 'node:path';
import { request } from './http.ts';
import type { HttpResponse } from './http.ts';
import {
	exitedWith, fixturesDir, hostPort, ipOf, nodeImage, readPin, startContainer, waitFor, webImageInfo,
} from './podman.ts';
import type { Stack } from './podman.ts';

// The server's APP_BASE_URL: stands in for the user's public server URL. The web app's own host is notes.example.test.
export const publicHost = 'joplin.example.test';
export const publicUrl = `https://${publicHost}`;
export const webAppHost = 'notes.example.test';
export const user1 = { email: 'user1@example.com', password: '111111' };

export interface JoplinServer {
	name: string;
	ip: string;
	port: number;
	url: string;
}

// Requests straight to the server's published port, with the Host its APP_BASE_URL expects (bypasses the proxy).
export const direct = (server: JoplinServer, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<HttpResponse> =>
	request({ port: server.port, path, method: opts.method, headers: { Host: publicHost, ...(opts.headers ?? {}) }, body: opts.body });

export const startJoplinServer = async (stack: Stack, { role, host, testing }: { role: string; host: number; testing: boolean }): Promise<JoplinServer> => {
	const pin = readPin();
	const name = startContainer(stack, {
		role,
		host,
		image: `${pin.server.image}:${pin.server.tag}`,
		publish: [22300],
		env: { APP_PORT: '22300', APP_BASE_URL: publicUrl, JOPLIN_IS_TESTING: testing ? '1' : undefined },
		command: ['node', 'dist/index.js', '--env', 'dev', '--env-file', '/dev/null'],
	});
	const server = { name, ip: ipOf(stack, host), port: hostPort(name, 22300), url: `http://${ipOf(stack, host)}:22300` };
	await waitFor(`${name} GET /api/ping → {"status":"ok"}`, async () => {
		const res = await direct(server, '/api/ping');
		return res.status === 200 && (JSON.parse(res.text) as { status?: string }).status === 'ok' ? true : undefined;
	}, { timeoutMs: 180_000, failFast: () => exitedWith(name) });
	const seeded = await direct(server, '/api/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'createTestUsers' }) });
	if (seeded.status !== 200) throw new Error(`createTestUsers on ${name} returned ${seeded.status}: ${seeded.text.slice(0, 500)}`);
	return server;
};

// ---- The web image under test ----

export interface WebEnv {
	JOPLIN_SERVER_URL: string;
	JOPLIN_SERVER_PUBLIC_URL: string;
	JOPLIN_SERVER_HOST?: string;
	COEP?: string;
	TRUSTED_PROXIES?: string;
	CLIENT_IP_HEADER?: string;
}

export interface Web {
	name: string;
	ip: string;
	port: number;
	internalPort: number;
}

// ADR-0006 hardening. No --user and no command: the image's own defaults are under test.
export const hardening = ['--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--memory', '128m'];

export const startWeb = async (stack: Stack, { role, host, env, caddyfile }: { role: string; host: number; env: WebEnv; caddyfile?: string }): Promise<Web> => {
	const { image } = webImageInfo();
	const name = startContainer(stack, {
		role,
		host,
		image,
		publish: [8080, 8089],
		env: { ...env },
		args: hardening,
		volumes: caddyfile ? [`${caddyfile}:/etc/caddy/Caddyfile:ro,Z`] : [],
	});
	const web = { name, ip: ipOf(stack, host), port: hostPort(name, 8080), internalPort: hostPort(name, 8089) };
	await waitFor(`${name} GET :8080/ → 200`, async () => ((await request({ port: web.port, path: '/' })).status === 200 ? true : undefined),
		{ timeoutMs: 60_000, failFast: () => exitedWith(name) });
	return web;
};

export const webEnvFor = (upstreamUrl: string, extra: Partial<WebEnv> = {}): WebEnv => ({
	JOPLIN_SERVER_URL: upstreamUrl,
	JOPLIN_SERVER_PUBLIC_URL: publicUrl,
	...extra,
});

// ---- Echo upstream ----

export interface Echo {
	name: string;
	ip: string;
	url: string;
	port: number;
}

export const startEcho = async (stack: Stack, { role, host }: { role: string; host: number }): Promise<Echo> => {
	const name = startContainer(stack, {
		role,
		host,
		image: nodeImage,
		publish: [8080],
		volumes: [`${join(fixturesDir, 'echo-server.mjs')}:/fixture/echo-server.mjs:ro,Z`],
		command: ['node', '/fixture/echo-server.mjs'],
	});
	const echo = { name, ip: ipOf(stack, host), url: `http://${ipOf(stack, host)}:8080`, port: hostPort(name, 8080) };
	await waitFor(`${name} echo ready`, async () => ((await request({ port: echo.port, path: '/ready' })).status === 200 ? true : undefined),
		{ timeoutMs: 60_000, failFast: () => exitedWith(name) });
	return echo;
};

export interface Echoed {
	method: string;
	url: string;
	peer: string;
	// Lower-cased header name → every value received, in order.
	headers: Record<string, string[]>;
}

export const parseEcho = (text: string): Echoed => {
	const raw = JSON.parse(text) as { method: string; url: string; peer: string; rawHeaders: string[] };
	const headers: Record<string, string[]> = {};
	for (let i = 0; i + 1 < raw.rawHeaders.length; i += 2) (headers[raw.rawHeaders[i].toLowerCase()] ??= []).push(raw.rawHeaders[i + 1]);
	return { method: raw.method, url: raw.url, peer: raw.peer, headers };
};
