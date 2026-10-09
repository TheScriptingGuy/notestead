// The supervisor's HTTP endpoint on :8090 (ADR-0003 Decision 6, ADR-0006). M1-S5 serves only `GET /healthz`:
//   503 {"state":"starting"} until the initial sync and decryption succeeded and the Data API answers,
//   200 {"state":"ready","lastSync":"<ISO-8601 UTC>"} after that.
// Nothing of the CLI's Data API is relayed (the gateway is opt-in and M3); every other path is 404.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { SyncStatus } from './syncStrategy.ts';

export const healthBody = (status: SyncStatus): { code: number; body: Record<string, string> } => {
	if (status.state === 'ready' && status.lastSync) return { code: 200, body: { state: 'ready', lastSync: status.lastSync } };
	return { code: 503, body: { state: status.state === 'ready' ? 'starting' : status.state } };
};

const sendJson = (res: ServerResponse, code: number, body: unknown, headOnly: boolean, extraHeaders: Record<string, string> = {}): void => {
	const text = JSON.stringify(body);
	res.writeHead(code, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(text),
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		...extraHeaders,
	});
	res.end(headOnly ? undefined : text);
};

export const handleRequest = (status: () => SyncStatus) => (req: IncomingMessage, res: ServerResponse): void => {
	const path = (req.url ?? '/').split('?')[0];
	const headOnly = req.method === 'HEAD';
	if (path !== '/healthz') {
		sendJson(res, 404, { error: 'not found' }, headOnly);
		return;
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		sendJson(res, 405, { error: 'method not allowed' }, false, { Allow: 'GET, HEAD' });
		return;
	}
	const { code, body } = healthBody(status());
	sendJson(res, code, body, headOnly);
};

export const startHealthServer = (options: { host: string; port: number; status: () => SyncStatus }): Promise<Server> => {
	const server = createServer(handleRequest(options.status));
	// Short timeouts: the endpoint answers at once, and nothing should hold sockets open.
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, options.host, () => {
			server.off('error', reject);
			resolve(server);
		});
	});
};
