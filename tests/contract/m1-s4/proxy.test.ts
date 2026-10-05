// M1-AC10 (proxy contract C1–C6, C8, C10, C1-neg) and M1-AC13 (internal listener :8089) against a real throwaway
// joplin/server (JOPLIN_IS_TESTING=1) behind the `web` image under test. ADR-0002 rules 1–8, ADR-0006, ADR-0008.
// Data-level checks read the server directly (its published port, Host = APP_BASE_URL host), bypassing the proxy.
// Test plan: docs/test-plans/M1-S4.md.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { cacheableBy, cacheDirectives, headerValue, request, requestHashed } from '../support/http.ts';
import type { HttpResponse } from '../support/http.ts';
import { containerLogs, containerState, createStack, teardownStack, waitFor, webImageInfo } from '../support/podman.ts';
import type { Stack } from '../support/podman.ts';
import { direct, publicUrl, startJoplinServer, startWeb, user1, webAppHost, webEnvFor } from '../support/services.ts';
import type { JoplinServer, Web } from '../support/services.ts';

const mib = 1024 * 1024;

// A note item in Joplin's sync format (the same shape spike S2 used), so the server can share it.
const noteItem = (id: string, title: string, body: string): string => [
	title, '', body, '',
	`id: ${id}`, 'parent_id: ', 'created_time: 2026-10-05T00:00:00.000Z', 'updated_time: 2026-10-05T00:00:00.000Z',
	'is_conflict: 0', 'latitude: 0.00000000', 'longitude: 0.00000000', 'altitude: 0.0000', 'author: ', 'source_url: ',
	'is_todo: 0', 'todo_due: 0', 'todo_completed: 0', 'source: joplin', 'source_application: net.cozic.joplin-desktop',
	'application_data: ', 'order: 0', 'user_created_time: 2026-10-05T00:00:00.000Z', 'user_updated_time: 2026-10-05T00:00:00.000Z',
	'encryption_cipher_text: ', 'encryption_applied: 0', 'markup_language: 1', 'is_shared: 0', 'share_id: ',
	'conflict_original_id: ', 'master_key_id: ', 'user_data: ', 'deleted_time: 0', 'type_: 1',
].join('\n');

const expectNoStoreNoTransform = (res: { headers: Record<string, unknown> }, what: string): void => {
	const value = headerValue(res.headers as Record<string, string | string[] | undefined>, 'cache-control');
	const directives = cacheDirectives(value);
	expect({ what, noStore: directives.has('no-store'), noTransform: directives.has('no-transform'), cacheable: cacheableBy(value) })
		.toEqual({ what, noStore: true, noTransform: true, cacheable: [] });
};

describe('M1-S4 proxy contract against a real joplin/server (M1-AC10, M1-AC13)', () => {
	let stack: Stack | undefined;
	let server: JoplinServer;
	let web: Web;
	let wrongHost: Web;

	beforeAll(async () => {
		webImageInfo(); // fail fast, before any container starts
		stack = createStack('proxy');
		server = await startJoplinServer(stack, { role: 'server', host: 30, testing: true });
		// JOPLIN_SERVER_HOST unset: the Host rewrite must default to the host of JOPLIN_SERVER_PUBLIC_URL (ADR-0002).
		web = await startWeb(stack, { role: 'web', host: 20, env: webEnvFor(server.url) });
		// C1-neg: the same image whose Host rewrite sends the web app's own host (what the server sees without it).
		wrongHost = await startWeb(stack, { role: 'web-wronghost', host: 21, env: webEnvFor(server.url, { JOPLIN_SERVER_HOST: webAppHost }) });
	});

	afterAll(() => teardownStack(stack));

	const login = async (port: number, headers: Record<string, string> = {}): Promise<{ res: HttpResponse; session: string }> => {
		const res = await request({ port, path: '/joplin-server/api/sessions', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(user1) });
		const session = res.status === 200 ? (JSON.parse(res.text) as { id?: string }).id ?? '' : '';
		return { res, session };
	};

	it('ac10-c1: GET /joplin-server/api/ping through the proxy returns {"status":"ok"} (Host rewritten by default)', async () => {
		const res = await request({ port: web.port, path: '/joplin-server/api/ping' });
		expect(res.status).toBe(200);
		expect((JSON.parse(res.text) as { status?: string }).status).toBe('ok');
	});

	it('ac10-c1-neg: the same image with a Host the server does not expect gets 404 "Invalid origin"', async () => {
		const res = await request({ port: wrongHost.port, path: '/joplin-server/api/ping' });
		expect(res.status).toBe(404);
		expect(res.text).toContain('Invalid origin');
	});

	it('ac10-c2: login through the proxy with a foreign Origin succeeds, and the server never sees the Origin', async () => {
		const { res, session } = await login(web.port, { Origin: `https://${webAppHost}` });
		expect(res.status).toBe(200);
		expect(session).toMatch(/^[A-Za-z0-9]{10,}$/);
		// Origin stripped (rule 3): the server's CORS layer would answer joplinapp.org with an allow-origin header.
		const viaProxy = await login(web.port, { Origin: 'https://joplinapp.org' });
		expect(viaProxy.res.status).toBe(200);
		expect(headerValue(viaProxy.res.headers, 'access-control-allow-origin')).toBeUndefined();
		const directly = await direct(server, '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://joplinapp.org' }, body: JSON.stringify(user1) });
		expect(directly.status).toBe(200);
		expect(headerValue(directly.headers, 'access-control-allow-origin')).toBe('https://joplinapp.org');
	});

	it('ac10-c3: items written through the proxy read back through the proxy, in the delta, and on the server itself', async () => {
		const { session } = await login(web.port);
		const auth = { 'X-API-AUTH': session };
		// A raw blob round-trips byte for byte, through the proxy and on the server.
		const blob = `m1s4-c3-${randomUUID()}.txt`;
		const content = `M1-S4 C3 ${randomUUID()}\n`;
		const put = await request({ port: web.port, path: `/joplin-server/api/items/root:/${blob}:/content`, method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: content });
		expect(put.status).toBe(200);
		const got = await request({ port: web.port, path: `/joplin-server/api/items/root:/${blob}:/content`, headers: auth });
		expect({ status: got.status, text: got.text }).toEqual({ status: 200, text: content });
		const onServer = await direct(server, `/api/items/root:/${blob}:/content`, { headers: auth });
		expect({ status: onServer.status, text: onServer.text }).toEqual({ status: 200, text: content });
		// A note item (the delta lists Joplin items only; spike S2 saw an empty delta for a blob) appears in the delta.
		const id = randomUUID().replace(/-/g, '');
		const marker = `M1-S4 C3 note ${randomUUID()}`;
		const note = await request({ port: web.port, path: `/joplin-server/api/items/root:/${id}.md:/content`, method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: noteItem(id, 'M1-S4 C3', marker) });
		expect(note.status).toBe(200);
		const delta = await request({ port: web.port, path: '/joplin-server/api/items/root:/:/delta', headers: auth });
		expect(delta.status).toBe(200);
		expect(delta.text).toContain(`${id}.md`);
		const noteBack = await request({ port: web.port, path: `/joplin-server/api/items/root:/${id}.md:/content`, headers: auth });
		expect(noteBack.text).toContain(marker);
		expect(noteBack.text).toContain(`id: ${id}`);
	});

	it('ac10-c4: the server UI is not re-published: /login, /admin, / and /users/me under /joplin-server return 404', async () => {
		for (const path of ['/joplin-server/login', '/joplin-server/admin', '/joplin-server/', '/joplin-server/users/me']) {
			const res = await request({ port: web.port, path });
			expect({ path, status: res.status }).toEqual({ path, status: 404 });
		}
		// Control: the server itself does serve its login page, so the 404s come from the proxy.
		expect((await direct(server, '/login')).status).toBe(200);
	});

	it('ac10-c5: a 100 MiB attachment round-trips through the proxy (128 MiB container limit) with an equal sha256', async () => {
		const { session } = await login(web.port);
		const id = randomUUID().replace(/-/g, '');
		const hash = createHash('sha256');
		let produced = 0;
		const body = new Readable({
			read() {
				if (produced >= 100 * mib) {
					this.push(null);
					return;
				}
				const chunk = randomBytes(Math.min(mib, 100 * mib - produced));
				produced += chunk.length;
				hash.update(chunk);
				this.push(chunk);
			},
		});
		const path = `/joplin-server/api/items/root:/.resource/${id}:/content`;
		const put = await request({ port: web.port, path, method: 'PUT', timeoutMs: 240_000, body,
			headers: { 'X-API-AUTH': session, 'Content-Type': 'application/octet-stream', 'Content-Length': String(100 * mib) } });
		expect(put.status).toBe(200);
		const uploaded = hash.digest('hex');
		const back = await requestHashed({ port: web.port, path, headers: { 'X-API-AUTH': session }, timeoutMs: 240_000 });
		expect({ status: back.status, size: back.size, sha256: back.sha256 }).toEqual({ status: 200, size: 100 * mib, sha256: uploaded });
		expect(containerState(web.name)).toEqual({ status: 'running', exitCode: 0, oomKilled: false });
	}, 600_000);

	it('ac10-c6: /joplin-server/shares/<id> redirects (302) to JOPLIN_SERVER_PUBLIC_URL/shares/<id>, which the server renders', async () => {
		const { session } = await login(web.port);
		const noteId = randomUUID().replace(/-/g, '');
		const marker = `M1-S4 published note ${randomUUID()}`;
		const put = await request({ port: web.port, path: `/joplin-server/api/items/root:/${noteId}.md:/content`, method: 'PUT',
			headers: { 'X-API-AUTH': session, 'Content-Type': 'application/octet-stream' }, body: noteItem(noteId, 'M1-S4 C6', marker) });
		expect(put.status).toBe(200);
		const share = await request({ port: web.port, path: '/joplin-server/api/shares', method: 'POST',
			headers: { 'X-API-AUTH': session, 'Content-Type': 'application/json' }, body: JSON.stringify({ note_id: noteId }) });
		expect(share.status).toBe(200);
		const shareId = (JSON.parse(share.text) as { id: string }).id;
		const res = await request({ port: web.port, path: `/joplin-server/shares/${shareId}` });
		expect(res.status).toBe(302);
		expect(headerValue(res.headers, 'location')).toBe(`${publicUrl}/shares/${shareId}`);
		// The redirect target is the real published note, rendered by the server on its own origin.
		const rendered = await direct(server, `/shares/${shareId}`);
		expect(rendered.status).toBe(200);
		expect(rendered.text).toContain(marker);
		// Nothing under /shares/ other than a single id redirects.
		for (const path of ['/joplin-server/shares/', `/joplin-server/shares/${shareId}/x`]) {
			const other = await request({ port: web.port, path });
			expect({ path, status: other.status }).toEqual({ path, status: 404 });
		}
	});

	it('ac10-c8: no X-API-AUTH, Authorization, Cookie, Cf-Access-Jwt-Assertion, CF-Access-Client-Secret or token= value reaches the access log', async () => {
		const { session } = await login(web.port);
		const marker = (kind: string): string => `m1s4${kind}${randomBytes(12).toString('hex')}`;
		const secrets = { apiAuth: marker('apiauth'), bearer: marker('bearer'), cookie: marker('cookie'), jwt: marker('jwt'), clientSecret: marker('cfsecret'), token: marker('token') };
		const probes = { public: `c8-${randomUUID()}`, internal: `c8i-${randomUUID()}`, session: `c8s-${randomUUID()}` };
		const headers = {
			'X-API-AUTH': secrets.apiAuth,
			Authorization: `Bearer ${secrets.bearer}`,
			Cookie: `jsession=${secrets.cookie}`,
			'Cf-Access-Jwt-Assertion': secrets.jwt,
			'CF-Access-Client-Secret': secrets.clientSecret,
		};
		await request({ port: web.port, path: `/joplin-server/api/${probes.public}?token=${secrets.token}`, headers });
		await request({ port: web.internalPort, path: `/joplin-server/api/${probes.internal}?token=${secrets.token}`, headers });
		await request({ port: web.port, path: `/joplin-server/api/items/root:/${probes.session}.txt:/content`, headers: { 'X-API-AUTH': session } });
		// Positive control: the access log exists and records these requests (on both listeners).
		const logs = await waitFor('the three probe requests in the access log', async () => {
			const text = containerLogs(web.name);
			return Object.values(probes).every(p => text.includes(p)) ? text : undefined;
		}, { timeoutMs: 30_000 });
		const leaked = [...Object.entries(secrets), ['session id', session]].filter(([, value]) => logs.includes(value)).map(([key]) => key);
		expect(leaked).toEqual([]);
	});

	it('ac10-c10: every response under /joplin-server/* carries Cache-Control: no-store, no-transform', async () => {
		const { res: loginRes, session } = await login(web.port);
		const responses: [string, HttpResponse][] = [
			['POST /api/sessions', loginRes],
			['GET /api/ping', await request({ port: web.port, path: '/joplin-server/api/ping' })],
			['GET /api/items (404 from the server)', await request({ port: web.port, path: `/joplin-server/api/items/root:/missing-${randomUUID()}.txt:/content`, headers: { 'X-API-AUTH': session } })],
			['GET /login (404 from the proxy)', await request({ port: web.port, path: '/joplin-server/login' })],
			['GET /shares/<id> (302)', await request({ port: web.port, path: '/joplin-server/shares/abcdef0123456789' })],
			['GET /api/ping, wrong Host (404 Invalid origin)', await request({ port: wrongHost.port, path: '/joplin-server/api/ping' })],
		];
		for (const [what, res] of responses) expectNoStoreNoTransform(res, what);
	});

	it('ac13-internal: :8089 proxies /joplin-server/api/* to the server', async () => {
		const res = await request({ port: web.internalPort, path: '/joplin-server/api/ping' });
		expect(res.status).toBe(200);
		expect((JSON.parse(res.text) as { status?: string }).status).toBe('ok');
	});

	it('ac13-neg: :8089 serves nothing else: /, /joplin-server/login, /index.html, /joplin-server/admin and /joplin-server/shares/<id> are 404', async () => {
		for (const path of ['/', '/joplin-server/login', '/index.html', '/joplin-server/admin', '/joplin-server/shares/abcdef0123456789']) {
			const res = await request({ port: web.internalPort, path });
			expect({ path, status: res.status }).toEqual({ path, status: 404 });
		}
		// Control: the public listener serves / (so the 404 is the internal listener's rule, not a missing bundle).
		expect((await request({ port: web.port, path: '/' })).status).toBe(200);
	});
});
