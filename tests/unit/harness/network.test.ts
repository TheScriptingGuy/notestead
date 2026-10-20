// The network-policy classifier of the web app (tests/e2e/support/network.ts; docs/test-plans/M2-S1.md Interpretation 2):
// only same-origin /joplin-server/api/* reaches the sync target, the sole cross-origin exception is
// `HEAD https://joplinapp.org/connection_check/`, anything else is a violation.
import { describe, expect, test } from '@jest/globals';
import { classifyRequests, violationLines } from '../../e2e/support/network.ts';
import type { NetEntry, NetVerdict } from '../../e2e/support/network.ts';

const app = 'http://127.0.0.1:41234';
const server = 'http://127.0.0.1:41235';

const entry = (method: string, url: string): NetEntry => ({ at: '2026-10-20T00:00:00.000Z', method, url, resourceType: 'fetch', fromServiceWorker: false });
const classify = (method: string, url: string): NetVerdict => classifyRequests([entry(method, url)], app);
const bucket = (v: NetVerdict): string => (Object.entries(v) as [string, unknown[]][]).filter(([, list]) => list.length > 0).map(([name]) => name).join(',');

describe('network policy classifier', () => {
	test('net-01 a same-origin bundle file is sameOriginOther', () => {
		expect(bucket(classify('GET', `${app}/app.bundle.js`))).toBe('sameOriginOther');
	});

	test('net-02 the sync login through the proxy is syncTraffic', () => {
		expect(bucket(classify('POST', `${app}/joplin-server/api/sessions`))).toBe('syncTraffic');
	});

	test('net-03 an item upload is syncTraffic, with the colons raw or percent-encoded', () => {
		expect(bucket(classify('PUT', `${app}/joplin-server/api/items/root:/info.json:/content`))).toBe('syncTraffic');
		expect(bucket(classify('PUT', `${app}/joplin-server/api/items/root%3A/info.json%3A/content`))).toBe('syncTraffic');
	});

	test('net-04 HEAD https://joplinapp.org/connection_check/ is the allowed external request', () => {
		expect(bucket(classify('HEAD', 'https://joplinapp.org/connection_check/'))).toBe('allowedExternal');
	});

	test('net-05 GET to the connection check is a violation', () => {
		expect(bucket(classify('GET', 'https://joplinapp.org/connection_check/'))).toBe('violations');
	});

	test('net-06 HEAD to the connection check with a query string is a violation', () => {
		expect(bucket(classify('HEAD', 'https://joplinapp.org/connection_check/?x=1'))).toBe('violations');
	});

	test('net-07 any other external URL is a violation', () => {
		expect(bucket(classify('GET', 'https://joplinapp.org/other'))).toBe('violations');
	});

	test('net-08 a request to the server\'s own port is a cross-origin violation', () => {
		const v = classify('GET', `${server}/api/ping`);
		expect(v.violations.map(x => x.why)).toEqual(['cross-origin request']);
	});

	test('net-09 the sync target outside /joplin-server/api/ is a violation, also without a path', () => {
		for (const url of [`${app}/joplin-server/shares/abc`, `${app}/joplin-server`]) {
			expect(classify('GET', url).violations.map(x => x.why)).toEqual(['same-origin request to the sync target outside /joplin-server/api/']);
		}
	});

	test('net-10 a websocket request is a violation', () => {
		expect(bucket(classify('GET', 'wss://127.0.0.1:41234/x'))).toBe('violations');
	});

	test('net-11 data: and blob: URLs are local and ignored', () => {
		expect(bucket(classify('GET', 'data:text/plain,x'))).toBe('ignored');
		expect(bucket(classify('GET', `blob:${app}/uuid`))).toBe('ignored');
	});

	test('net-12 violation lines carry method, origin, path and reason, never the query string', () => {
		const lines = violationLines(classify('GET', 'https://example.invalid/leak?token=abc'));
		expect(lines).toEqual(['GET https://example.invalid/leak: cross-origin request']);
		expect(lines.join('\n')).not.toMatch(/token|abc/);
	});
});
