// DNS-1: the web proxy must survive a first nameserver that never answers (docs/test-plans/DNS-1.md).
// Ground truth from docs/worklog/DNS-1.md: Go's resolver waits 5 s per nameserver; Caddy's default dial_timeout is
// 3 s; so one silent first nameserver in /etc/resolv.conf turned the first proxied request of a fresh `web` into a 502.
// Every case starts a FRESH `web` (Caddy keeps upstream connections alive, so only the first proxied request of a
// fresh `web` reliably dials and looks up). The fault is a UDP sink at <prefix>.53 that never answers, listed first in a
// resolv.conf derived from podman's own. Self-checks in every fault case: the mounted file is the one inside `web`, and
// the sink's query count rises during the request. Bounds are planner-owned (plan note 3): never widen them here.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseResolvConf, noDialTimeoutCaddyfile, recordTiming, sinkQueries, startSink, timedRequest, writeResolvVariants } from '../support/dns.ts';
import type { ResolvVariants, Sink } from '../support/dns.ts';
import { request } from '../support/http.ts';
import { sessionFor } from '../support/headless.ts';
import {
	containerLogs, createStack, ipOf, podman, runId, teardownStack, waitFor, webImageInfo,
} from '../support/podman.ts';
import type { Stack } from '../support/podman.ts';
import { direct, startJoplinServer, startWeb, user1, webEnvFor } from '../support/services.ts';
import type { JoplinServer, Web } from '../support/services.ts';

// A note item in Joplin's sync format (as tests/contract/m1-s4/proxy.test.ts noteItem).
const noteItem = (id: string, title: string, body: string): string => [
	title, '', body, '',
	`id: ${id}`, 'parent_id: ', 'created_time: 2026-10-05T00:00:00.000Z', 'updated_time: 2026-10-05T00:00:00.000Z',
	'is_conflict: 0', 'latitude: 0.00000000', 'longitude: 0.00000000', 'altitude: 0.0000', 'author: ', 'source_url: ',
	'is_todo: 0', 'todo_due: 0', 'todo_completed: 0', 'source: joplin', 'source_application: net.cozic.joplin-desktop',
	'application_data: ', 'order: 0', 'user_created_time: 2026-10-05T00:00:00.000Z', 'user_updated_time: 2026-10-05T00:00:00.000Z',
	'encryption_cipher_text: ', 'encryption_applied: 0', 'markup_language: 1', 'is_shared: 0', 'share_id: ',
	'conflict_original_id: ', 'master_key_id: ', 'user_data: ', 'deleted_time: 0', 'type_: 1',
].join('\n');

const json = (text: string): Record<string, unknown> => {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return {};
	}
};

describe('DNS-1 the proxy survives a silent first nameserver (DNS1-AC1 to AC3)', () => {
	let stack: Stack;
	let server: JoplinServer;
	let sink: Sink;
	let variants: ResolvVariants;
	let baseText: string;
	let user1Session: string;

	beforeAll(async () => {
		webImageInfo(); // fail fast, before any container starts
		stack = createStack('proxy-dns', 'dns-1');
		writeFileSync(join(stack.logsDir, 'timings.json'), '[]\n');
		server = await startJoplinServer(stack, { role: 'server', host: 30, testing: true, aliases: ['server'] });
		sink = await startSink(stack);
		baseText = baseResolvConf(stack);
		variants = writeResolvVariants(stack, baseText, sink.ip);
		user1Session = await sessionFor(server, user1.email, user1.password);
	});

	afterAll(() => teardownStack(stack));

	// The server's items for user1, read directly (bypasses the proxy).
	const itemNames = async (): Promise<string[]> => {
		const res = await direct(server, '/api/items/root:/:/children', { headers: { 'X-API-AUTH': user1Session } });
		expect(res.status).toBe(200);
		return ((json(res.text).items ?? []) as { name: string }[]).map(i => i.name).sort();
	};

	// Self-check: the resolv.conf mounted into `web` is the one it sees.
	const expectMounted = (web: Web, file: string): void => {
		const inside = podman(['exec', web.name, 'cat', '/etc/resolv.conf']).stdout;
		expect(inside).toBe(readFileSync(file, 'utf8'));
	};

	const startCase = (role: string, host: number, opts: { resolv?: string; caddyfile?: string; serverUrl?: string } = {}): Promise<Web> =>
		startWeb(stack, { role, host, env: webEnvFor(opts.serverUrl ?? 'http://server:22300'), resolvConf: opts.resolv, caddyfile: opts.caddyfile });

	const proxyErrorLog = (web: Web): Promise<string> => waitFor(`an error line in ${web.name}'s log`, async () => {
		const log = containerLogs(web.name);
		return /"level":"error"/.test(log) ? log : undefined;
	}, { timeoutMs: 30_000 });

	const login = (port: number) => timedRequest({ port, path: '/joplin-server/api/sessions', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user1), timeoutMs: 60_000 });

	it('dns1-c0: baseline, podman\'s own resolv.conf mounted (no sink line): ping is 200 in under 2.5 s and the sink hears nothing', async () => {
		const base = join(stack.logsDir, 'resolv.base');
		const web = await startCase('web-c0', 20, { resolv: base });
		expectMounted(web, base);
		const before = sinkQueries(sink.name);
		const { res, elapsedMs } = await timedRequest({ port: web.port, path: '/joplin-server/api/ping' });
		const delta = sinkQueries(sink.name) - before;
		recordTiming(stack, { case: 'dns1-c0', status: res.status, elapsedMs, sinkQueriesDelta: delta });
		expect(res.status).toBe(200);
		expect(json(res.text).status).toBe('ok');
		expect(elapsedMs).toBeLessThan(2500);
		expect(delta).toBe(0);
	});

	it.each([['dns1-c1', 'public :8080', 21, false], ['dns1-c1b', 'internal :8089', 22, true]] as const)('%s: a first nameserver that never answers, request on the %s: 200 within 9 s, no lookup error in web', async (id, _listener, host, internal) => {
		const web = await startCase(`web-${id}`, host, { resolv: variants.sinkFirst });
		expectMounted(web, variants.sinkFirst);
		const before = sinkQueries(sink.name);
		const { res, elapsedMs } = await timedRequest({ port: internal ? web.internalPort : web.port, path: '/joplin-server/api/ping' });
		const delta = sinkQueries(sink.name) - before;
		recordTiming(stack, { case: id, status: res.status, elapsedMs, sinkQueriesDelta: delta });
		expect(delta).toBeGreaterThan(0); // the fault was on the path
		expect({ status: res.status, text: res.status === 200 ? json(res.text).status : res.text.slice(0, 200) }).toEqual({ status: 200, text: 'ok' });
		expect(elapsedMs).toBeLessThan(9000);
		const log = containerLogs(web.name);
		expect(log).not.toMatch(/lookup server\b/);
		expect(log).not.toMatch(/dial tcp/);
	});

	it('dns1-c1-neg: the same fault against a Caddyfile without a dial_timeout block detects the defect: 502 at about 3 s, "lookup server: i/o timeout" in the log', async () => {
		const variant = noDialTimeoutCaddyfile(stack);
		const web = await startCase('web-c1neg', 23, { resolv: variants.sinkFirst, caddyfile: variant.file });
		expectMounted(web, variants.sinkFirst);
		const before = sinkQueries(sink.name);
		const { res, elapsedMs } = await timedRequest({ port: web.port, path: '/joplin-server/api/ping' });
		const delta = sinkQueries(sink.name) - before;
		recordTiming(stack, { case: 'dns1-c1-neg', status: res.status, elapsedMs, sinkQueriesDelta: delta, removedBlocks: variant.removedBlocks });
		expect(res.status).toBe(502);
		expect(elapsedMs).toBeGreaterThanOrEqual(2500);
		expect(elapsedMs).toBeLessThanOrEqual(4500);
		expect(delta).toBeGreaterThan(0);
		const log = await waitFor(`the lookup timeout line in ${web.name}'s log`, async () => {
			const text = containerLogs(web.name);
			return /lookup server\b[^"]*i\/o timeout/.test(text) ? text : undefined;
		}, { timeoutMs: 30_000 });
		expect(log).toMatch(/lookup server\b[^"]*i\/o timeout/);
	});

	it('dns1-c2: the first request of a fresh web is the login POST: 200 and a session within 9 s; a sync PUT then lands on the server exactly once', async () => {
		const web = await startCase('web-c2', 24, { resolv: variants.sinkFirst });
		expectMounted(web, variants.sinkFirst);
		const before = sinkQueries(sink.name);
		const { res, elapsedMs } = await login(web.port);
		const delta = sinkQueries(sink.name) - before;
		recordTiming(stack, { case: 'dns1-c2', status: res.status, elapsedMs, sinkQueriesDelta: delta });
		expect(delta).toBeGreaterThan(0);
		expect(res.status).toBe(200);
		const session = String(json(res.text).id ?? '');
		expect(session).toMatch(/^[A-Za-z0-9]{10,}$/);
		expect(elapsedMs).toBeLessThan(9000);
		const id = randomBytes(16).toString('hex');
		const name = `${id}.md`;
		const content = noteItem(id, `DNS-1 c2 ${randomUUID()}`, `DNS-1 c2 body ${randomUUID()}`);
		const put = await request({ port: web.port, path: `/joplin-server/api/items/root:/${name}:/content`, method: 'PUT', headers: { 'X-API-AUTH': session, 'Content-Type': 'application/octet-stream' }, body: content });
		expect(put.status).toBe(200);
		// Directly on the server: the exact bytes, and the name listed exactly once.
		const onServer = await direct(server, `/api/items/root:/${name}:/content`, { headers: { 'X-API-AUTH': session } });
		expect({ status: onServer.status, text: onServer.text }).toEqual({ status: 200, text: content });
		expect((await itemNames()).filter(n => n === name)).toEqual([name]);
	});

	it('dns1-c2-neg: the same first POST through the Caddyfile without a dial_timeout block gets 502 at about 3 s, and the server saw nothing', async () => {
		const variant = noDialTimeoutCaddyfile(stack);
		const web = await startCase('web-c2neg', 25, { resolv: variants.sinkFirst, caddyfile: variant.file });
		expectMounted(web, variants.sinkFirst);
		const itemsBefore = await itemNames();
		const before = sinkQueries(sink.name);
		const { res, elapsedMs } = await login(web.port);
		const delta = sinkQueries(sink.name) - before;
		recordTiming(stack, { case: 'dns1-c2-neg', status: res.status, elapsedMs, sinkQueriesDelta: delta, removedBlocks: variant.removedBlocks });
		expect(res.status).toBe(502);
		expect(elapsedMs).toBeGreaterThanOrEqual(2500);
		expect(elapsedMs).toBeLessThanOrEqual(4500);
		expect(delta).toBeGreaterThan(0);
		// A 502 at the lookup means nothing was sent: the server's item list is unchanged.
		expect(await itemNames()).toEqual(itemsBefore);
	});

	it('dns1-c2b: the first request on the internal listener :8089 is the login POST: 200 and a session that works directly on the server', async () => {
		const web = await startCase('web-c2b', 26, { resolv: variants.sinkFirst });
		expectMounted(web, variants.sinkFirst);
		const before = sinkQueries(sink.name);
		const { res, elapsedMs } = await login(web.internalPort);
		const delta = sinkQueries(sink.name) - before;
		recordTiming(stack, { case: 'dns1-c2b', status: res.status, elapsedMs, sinkQueriesDelta: delta });
		expect(delta).toBeGreaterThan(0);
		expect(res.status).toBe(200);
		const session = String(json(res.text).id ?? '');
		expect(session).toMatch(/^[A-Za-z0-9]{10,}$/);
		expect(elapsedMs).toBeLessThan(9000);
		const children = await direct(server, '/api/items/root:/:/children', { headers: { 'X-API-AUTH': session } });
		expect(children.status).toBe(200);
	});

	// AC3 guards (plan note 2): they pass before and after the fix; their negative is the bound itself.
	const expectBoundedFailure = async (id: string, web: Web, sinkExpected: boolean): Promise<void> => {
		const before = sinkQueries(sink.name);
		const { res, elapsedMs } = await timedRequest({ port: web.port, path: '/joplin-server/api/ping', timeoutMs: 60_000 });
		const delta = sinkQueries(sink.name) - before;
		recordTiming(stack, { case: id, status: res.status, elapsedMs, sinkQueriesDelta: delta });
		expect([502, 504]).toContain(res.status);
		expect(elapsedMs).toBeLessThan(15_000);
		await proxyErrorLog(web);
		if (sinkExpected) expect(delta).toBeGreaterThan(0);
	};

	it('dns1-c3a: a server name that does not exist fails with 502 or 504 within 15 s and web logs an error', async () => {
		const web = await startCase('web-c3a', 27, { serverUrl: `http://nst-dns1-missing-${runId()}:22300` });
		await expectBoundedFailure('dns1-c3a', web, false);
	});

	it('dns1-c3b: an address that refuses the connection (the sink: up, TCP 22300 closed) fails with 502 or 504 within 15 s and web logs an error', async () => {
		const web = await startCase('web-c3b', 28, { serverUrl: `http://${sink.ip}:22300` });
		await expectBoundedFailure('dns1-c3b', web, false);
	});

	it('dns1-c3c: an address with no host fails with 502 or 504 within 15 s and web logs an error', async () => {
		const web = await startCase('web-c3c', 29, { serverUrl: `http://${ipOf(stack, 250)}:22300` });
		await expectBoundedFailure('dns1-c3c', web, false);
	});

	it('dns1-c3d: every nameserver silent fails with 502 or 504 within 15 s, web logs an error, the sink heard the lookup, the server is untouched', async () => {
		const itemsBefore = await itemNames();
		const web = await startCase('web-c3d', 40, { resolv: variants.sinkOnly });
		expectMounted(web, variants.sinkOnly);
		await expectBoundedFailure('dns1-c3d', web, true);
		expect(await itemNames()).toEqual(itemsBefore);
	});
});
