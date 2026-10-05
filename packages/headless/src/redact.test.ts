import { Redactor } from './redact.ts';

describe('Redactor', () => {
	test('replaces known secrets, including their JSON-escaped form', () => {
		const r = new Redactor(['pw Δ$x!', 'master']);
		expect(r.redact('login with pw Δ$x! and master')).toBe('login with [redacted] and [redacted]');
		const escaped = new Redactor(['a"b']);
		expect(escaped.redact('{"p":"a\\"b"}')).toBe('{"p":"[redacted]"}');
	});

	test('replaces a secret that contains another one as a whole', () => {
		const r = new Redactor(['abc', 'abcdef']);
		expect(r.redact('x abcdef y abc')).toBe('x [redacted] y [redacted]');
	});

	test('drops query strings from URLs and request lines', () => {
		const r = new Redactor();
		expect(r.redact('Request: GET /notes?token=0123abcd&fields=id,title')).toBe('Request: GET /notes?[redacted]');
		expect(r.redact('fetch http://127.0.0.1:41184/ping?a=1 failed')).toBe('fetch http://127.0.0.1:41184/ping?[redacted] failed');
	});

	test('masks token= values wherever they appear', () => {
		expect(new Redactor().redact('body token=0123abcd&x=1')).toBe('body token=[redacted]&x=1');
	});

	test('negative control: leaves ordinary text alone', () => {
		const r = new Redactor(['secret']);
		for (const line of ['Completed: 05/10/2026 18:15 (6s)', 'Are you sure? yes', 'Last error: FetchError: connect ECONNREFUSED 10.0.0.1:8099']) {
			expect(r.redact(line)).toBe(line);
		}
	});

	test('ignores an empty secret', () => {
		const r = new Redactor(['']);
		expect(r.redact('abc')).toBe('abc');
	});
});
