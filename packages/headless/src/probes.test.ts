import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pingDataApi, pingSyncTarget, waitUntilReady } from './probes.ts';
import type { ProbeResult } from './probes.ts';

const listen = (handler: (url: string) => { status: number; body: string }): Promise<{ server: Server; port: number }> => new Promise(resolve => {
	const server = createServer((req, res) => {
		const { status, body } = handler(req.url ?? '');
		res.writeHead(status);
		res.end(body);
	});
	server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
});

const close = (server: Server): Promise<void> => new Promise(resolve => server.close(() => resolve()));

// A port with nothing listening on it: bind, read the port, close.
const closedPort = async (): Promise<number> => {
	const { server, port } = await listen(() => ({ status: 200, body: '' }));
	await close(server);
	return port;
};

describe('probes', () => {
	test('pingSyncTarget accepts only a Joplin Server ping response', async () => {
		let reply = { status: 200, body: '{"status":"ok","message":"Joplin Server is running"}' };
		const seen: string[] = [];
		const { server, port } = await listen(url => {
			seen.push(url);
			return reply;
		});
		try {
			const base = `http://127.0.0.1:${port}/joplin-server`;
			expect(await pingSyncTarget(base)).toEqual({ ok: true, detail: 'ok' });
			expect(seen).toEqual(['/joplin-server/api/ping']);
			reply = { status: 502, body: 'Bad Gateway' };
			expect(await pingSyncTarget(base)).toEqual({ ok: false, detail: 'HTTP 502' });
			reply = { status: 200, body: '<html>' };
			expect(await pingSyncTarget(base)).toEqual({ ok: false, detail: 'not a Joplin Server ping response' });
			reply = { status: 200, body: '{"status":"down"}' };
			expect(await pingSyncTarget(base)).toEqual({ ok: false, detail: 'status "down"' });
		} finally {
			await close(server);
		}
	});

	test('pingSyncTarget reports a refused connection', async () => {
		expect(await pingSyncTarget(`http://127.0.0.1:${await closedPort()}/joplin-server`)).toEqual({ ok: false, detail: 'ECONNREFUSED' });
	});

	test('pingDataApi accepts only the Data API ping text', async () => {
		let body = 'JoplinClipperServer';
		const { server, port } = await listen(() => ({ status: 200, body }));
		try {
			expect(await pingDataApi(port)).toEqual({ ok: true, detail: 'ok' });
			body = 'something else';
			expect(await pingDataApi(port)).toEqual({ ok: false, detail: 'HTTP 200' });
		} finally {
			await close(server);
		}
	});

	test('waitUntilReady polls until the probe succeeds', async () => {
		const results: ProbeResult[] = [{ ok: false, detail: 'a' }, { ok: false, detail: 'b' }, { ok: true, detail: 'ok' }];
		let calls = 0;
		await waitUntilReady(async () => results[calls++], { timeoutMs: 5_000, intervalMs: 1 });
		expect(calls).toBe(3);
	});

	test('waitUntilReady fails with the last detail at the deadline, or at once when abortIf names a reason', async () => {
		await expect(waitUntilReady(async () => ({ ok: false, detail: 'still down' }), { timeoutMs: 0, intervalMs: 1 })).rejects.toThrow('not ready after 0 ms (last: still down)');
		let calls = 0;
		await expect(waitUntilReady(async () => {
			calls++;
			return { ok: false, detail: 'x' };
		}, { timeoutMs: 5_000, intervalMs: 1, abortIf: () => (calls >= 2 ? 'the server exited' : undefined) })).rejects.toThrow('the server exited');
		expect(calls).toBe(2);
	});
});
