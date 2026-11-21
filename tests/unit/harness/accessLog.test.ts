// The access log of a test's own `web` container, parsed from Caddy's JSON lines (docs/test-plans/M2-S5.md D4, al-01…04).
import { describe, expect, test } from '@jest/globals';
import { parseAccessLog } from '../../e2e/support/accessLog.ts';

const access = (over: { uri?: string; status?: number; method?: string; ts?: number; logger?: string } = {}): string => JSON.stringify({
	level: 'info',
	ts: over.ts ?? 1763700000.5,
	logger: over.logger ?? 'http.log.access.log0',
	msg: 'handled request',
	request: { remote_ip: '10.0.2.100', method: over.method ?? 'GET', host: '127.0.0.1:8080', uri: over.uri ?? '/', headers: { 'User-Agent': ['x'] } },
	status: over.status ?? 200,
	size: 10,
});

describe('access log', () => {
	test('al-01 an access line gives its method, path, status and time in milliseconds', () => {
		expect(parseAccessLog(access({ uri: '/app.bundle.js', ts: 1763700000.5 }))).toEqual([{ method: 'GET', path: '/app.bundle.js', status: 200, ts: 1763700000500 }]);
	});

	test('al-02 the query string is never kept, the token included', () => {
		const [entry] = parseAccessLog(access({ uri: '/joplin-server/api/ping?token=abcdef&x=1' }));
		expect(entry.path).toBe('/joplin-server/api/ping');
		expect(JSON.stringify(entry)).not.toContain('abcdef');
		expect(parseAccessLog(access({ uri: '/source.html?probe=nst1' }))[0].path).toBe('/source.html');
	});

	test('al-03 lines that are not JSON or not access entries are ignored, the others keep their order', () => {
		const text = ['starting up', '', '{"level":"info","logger":"tls","msg":"x"}', access({ uri: '/a' }), '{not json', access({ logger: 'http.log.error', uri: '/err' }), access({ uri: '/b', method: 'POST' })].join('\n');
		expect(parseAccessLog(text).map(e => `${e.method} ${e.path}`)).toEqual(['GET /a', 'POST /b']);
		expect(parseAccessLog('')).toEqual([]);
		expect(parseAccessLog(JSON.stringify({ logger: 'http.log.access.log0' }))).toEqual([]);
	});

	test('al-04 the status is kept as the server answered it', () => {
		const text = [access({ uri: '/a', status: 304 }), access({ uri: '/b', status: 404 }), access({ uri: '/c', status: 200 })].join('\n');
		expect(parseAccessLog(text).map(e => e.status)).toEqual([304, 404, 200]);
	});
});
