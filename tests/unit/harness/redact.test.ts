// Unit tests of the harness's redaction and zip code (tests/support/redact.ts, zip.ts; docs/test-plans/M1-S6.md,
// M1-AC20 layer "unit"). The M1-AC20 self-test proves the same on real artifacts; these pin the rules cheaply.
import { describe, expect, test } from '@jest/globals';
import { findLeaks, redactBuffer, redactDocument, redactText, textViews } from '../../support/redact.ts';
import { readZip, writeZip } from '../../support/zip.ts';

describe('harness redaction', () => {
	test('token= query values and credential header lines are redacted, other text is kept', () => {
		// A header value runs to the end of its line (conservative: the rest of the line goes too).
		const out = redactText('GET /api/notes?token=abc123&x=1 keep-me\nX-API-AUTH: sess42\nAuthorization: Bearer xyz');
		expect(out).toBe('GET /api/notes?token=[REDACTED]&x=1 keep-me\nX-API-AUTH: [REDACTED]\nAuthorization: [REDACTED]');
		expect(redactText('plain text without secrets')).toBe('plain text without secrets');
	});

	test('caddy-style JSON headers keep valid JSON and lose the values', () => {
		const line = JSON.stringify({ request: { uri: '/api/x?token=t0k3n', headers: { 'X-Api-Auth': ['s3ss'], 'Cookie': ['a=b'], 'Accept': ['*/*'] } } });
		const out = JSON.parse(redactDocument(line)) as { request: { uri: string; headers: Record<string, string[]> } };
		expect(out.request.uri).toBe('/api/x?token=[REDACTED]');
		expect(out.request.headers['X-Api-Auth']).toEqual(['[REDACTED]']);
		expect(out.request.headers.Cookie).toEqual(['[REDACTED]']);
		expect(out.request.headers.Accept).toEqual(['*/*']);
	});

	test('playwright-style {name, value} header pairs are redacted structurally', () => {
		const line = JSON.stringify({ type: 'resource-snapshot', snapshot: { request: { url: 'http://h/a?token=q1w2e3', headers: [{ name: 'X-API-AUTH', value: 'p0p0' }, { name: 'Accept', value: 'json' }] } } });
		const out = redactDocument(line);
		expect(out).not.toContain('p0p0');
		expect(out).not.toContain('q1w2e3');
		expect(out).toContain('"Accept","value":"json"');
		expect(findLeaks('x', out)).toEqual([]);
		expect(findLeaks('x', line).map(l => l.kind).sort()).toEqual(['X-API-AUTH (header pair)', 'token=']);
	});

	test('har queryString token pairs and cookies are redacted', () => {
		const line = JSON.stringify({ request: { queryString: [{ name: 'token', value: 't9t9t9' }, { name: 'page', value: '2' }], cookies: [{ name: 'sid', value: 'c1c1c1' }] } });
		const out = redactDocument(line);
		expect(out).not.toContain('t9t9t9');
		expect(out).not.toContain('c1c1c1');
		expect(out).toContain('"name":"page","value":"2"');
		expect(findLeaks('x', line).map(l => l.kind)).toEqual(['token (header pair)']);
		expect(findLeaks('x', out)).toEqual([]);
	});

	test('known secrets are replaced by their label, also URL- and JSON-encoded', () => {
		const secret = { label: 'pw', value: 'nst pw"Δ$x!' };
		const text = `a ${secret.value} b ${encodeURIComponent(secret.value)} c ${JSON.stringify(secret.value)}`;
		const out = redactText(text, [secret]);
		expect(out).not.toContain('nst pw');
		expect(findLeaks('x', out, { secrets: [secret] })).toEqual([]);
	});

	test('a zip (trace) round-trips and its text entries are redacted, binary entries kept byte for byte', () => {
		const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
		const zip = writeZip([
			{ name: 'trace.network', data: Buffer.from(`${JSON.stringify({ headers: [{ name: 'Cookie', value: 'c00k1e' }] })}\n`) },
			{ name: 'resources/shot.png', data: binary },
		]);
		expect(readZip(zip).map(e => e.name)).toEqual(['trace.network', 'resources/shot.png']);
		const redactedZip = redactBuffer(zip);
		const entries = readZip(redactedZip);
		expect(entries[0].data.toString('utf8')).not.toContain('c00k1e');
		expect(entries[1].data.equals(binary)).toBe(true);
		expect(textViews('t.zip', redactedZip).map(v => v.where)).toEqual(['t.zip!trace.network']);
	});

	test('findLeaks: forbidden patterns, and header names in prose are not leaks', () => {
		expect(findLeaks('x', 'no unredacted X-API-AUTH values, token= or Authorization here')).toEqual([]);
		expect(findLeaks('x', 'found nstsecretabcdef0123456789abcdef01 here', { forbidden: [/nstsecret[0-9a-f]{24}/] })).toHaveLength(1);
	});
});
