import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHealthServer } from './healthServer.ts';
import type { SyncStatus } from './syncStrategy.ts';

describe('health server', () => {
	let server: Server;
	let base: string;
	let status: SyncStatus;

	beforeEach(async () => {
		status = { state: 'starting' };
		server = await startHealthServer({ host: '127.0.0.1', port: 0, status: () => status });
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise(resolve => server.close(resolve));
	});

	const get = async (path: string, method = 'GET'): Promise<{ status: number; type: string | null; body: string }> => {
		const res = await fetch(`${base}${path}`, { method });
		return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
	};

	test('answers GET /healthz with 503 {"state":"starting"} until ready, then 200 with lastSync', async () => {
		expect(await get('/healthz')).toEqual({ status: 503, type: 'application/json; charset=utf-8', body: '{"state":"starting"}' });
		status = { state: 'ready', lastSync: '2026-10-05T18:15:00.000Z' };
		expect(await get('/healthz')).toEqual({ status: 200, type: 'application/json; charset=utf-8', body: '{"state":"ready","lastSync":"2026-10-05T18:15:00.000Z"}' });
		expect((await get('/healthz?x=1')).status).toBe(200);
		status = { state: 'stopping', lastSync: '2026-10-05T18:15:00.000Z' };
		expect(await get('/healthz')).toEqual({ status: 503, type: 'application/json; charset=utf-8', body: '{"state":"stopping"}' });
	});

	test('answers HEAD /healthz with the status and no body; other methods get 405', async () => {
		expect(await get('/healthz', 'HEAD')).toEqual({ status: 503, type: 'application/json; charset=utf-8', body: '' });
		expect((await get('/healthz', 'POST')).status).toBe(405);
	});

	test('relays nothing of the Data API: every other path is 404', async () => {
		status = { state: 'ready', lastSync: '2026-10-05T18:15:00.000Z' };
		for (const path of ['/', '/ping', '/notes', '/api/ping', '/api/notes/abc', '/healthz/x']) {
			expect({ path, ...(await get(path)) }).toEqual({ path, status: 404, type: 'application/json; charset=utf-8', body: '{"error":"not found"}' });
		}
	});
});
