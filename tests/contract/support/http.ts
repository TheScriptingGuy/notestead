// Raw HTTP from the test process (node:http, so any header can be set, Host included, and nothing is decompressed
// behind the test's back). Bodies can be streamed both ways for the 100 MiB round trip (M1-AC10 C5).
// `agent: false`: one connection per request, never pooled (M1-S5 dispute D1). Node's global agent keeps sockets alive;
// while a test blocks the event loop (spawnSync of an image build), the server closes an idle pooled socket unseen,
// and the next request is handed the dead socket (`socket hang up`).
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

export interface HttpResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
	text: string;
}

export interface HttpRequest {
	port: number;
	path: string;
	method?: string;
	headers?: Record<string, string>;
	body?: Buffer | string | Readable;
	timeoutMs?: number;
}

const send = (req: HttpRequest, onResponse: (res: http.IncomingMessage, resolve: (value: unknown) => void, reject: (error: Error) => void) => void): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const r = http.request({ host: '127.0.0.1', port: req.port, path: req.path, method: req.method ?? 'GET', headers: req.headers ?? {}, agent: false }, res => onResponse(res, resolve, reject));
		r.setTimeout(req.timeoutMs ?? 60_000, () => r.destroy(new Error(`timeout after ${req.timeoutMs ?? 60_000} ms: ${req.method ?? 'GET'} :${req.port}${req.path}`)));
		r.on('error', reject);
		const body = req.body;
		if (body === undefined) r.end();
		else if (typeof body === 'string' || Buffer.isBuffer(body)) r.end(body);
		else {
			body.on('error', reject);
			body.pipe(r);
		}
	});

export const request = async (req: HttpRequest): Promise<HttpResponse> => send(req, (res, resolve, reject) => {
	const chunks: Buffer[] = [];
	res.on('data', (chunk: Buffer) => chunks.push(chunk));
	res.on('error', reject);
	res.on('end', () => {
		const body = Buffer.concat(chunks);
		resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
	});
}) as Promise<HttpResponse>;

export interface HashedResponse {
	status: number;
	headers: IncomingHttpHeaders;
	sha256: string;
	size: number;
}

// Streams the response body into a hash (no buffering).
export const requestHashed = async (req: HttpRequest): Promise<HashedResponse> => send(req, (res, resolve, reject) => {
	const hash = createHash('sha256');
	let size = 0;
	res.on('data', (chunk: Buffer) => {
		hash.update(chunk);
		size += chunk.length;
	});
	res.on('error', reject);
	res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, sha256: hash.digest('hex'), size }));
}) as Promise<HashedResponse>;

export const headerValue = (headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>, name: string): string | undefined => {
	const value = headers[name.toLowerCase()];
	return Array.isArray(value) ? value.join(', ') : value;
};

// Cache-Control directives, lower-cased: `no-store` → true, `max-age=0` → '0'.
export const cacheDirectives = (value: string | undefined): Map<string, string | true> => {
	const directives = new Map<string, string | true>();
	for (const part of (value ?? '').split(',').map(p => p.trim()).filter(p => p !== '')) {
		const eq = part.indexOf('=');
		if (eq < 0) directives.set(part.toLowerCase(), true);
		else directives.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim().replace(/^"|"$/g, ''));
	}
	return directives;
};

// A positive max-age or s-maxage, or `public`/`immutable`: anything that lets a front cache the response.
export const cacheableBy = (value: string | undefined): string[] => {
	const found: string[] = [];
	const directives = cacheDirectives(value);
	for (const key of ['max-age', 's-maxage']) {
		const v = directives.get(key);
		if (typeof v === 'string' && Number.parseInt(v, 10) > 0) found.push(`${key}=${v}`);
	}
	for (const key of ['public', 'immutable']) if (directives.has(key)) found.push(key);
	return found;
};
