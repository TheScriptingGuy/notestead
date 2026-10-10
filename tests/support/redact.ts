// Redaction for every artifact the harness keeps (ADR-0007, ADR-0008, docs/testing/strategy.md §5): container logs,
// browser console, Playwright traces and any other attachment. Query `token=` values, the credential headers
// (X-API-AUTH, Authorization, Cookie, Set-Cookie, the Cloudflare Access credentials, Proxy-Authorization) and every
// secret value the harness knows (passwords, the Data API token) are replaced. Shared by Jest and Playwright.
import { readFileSync, writeFileSync } from 'node:fs';
import { readZip, writeZip } from './zip.ts';

export const redacted = '[REDACTED]';

export const credentialHeaders = [
	'x-api-auth', 'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
	'cf-access-jwt-assertion', 'cf-access-client-secret',
];

export interface KnownSecret {
	label: string;
	value: string;
}

const headerAlternation = credentialHeaders.map(h => h.replace(/-/g, '[-_]')).join('|');
// `Name: value`, `"Name": "value"`, `"Name":["value"]` (Caddy's JSON log), `Name=value`. The value runs to the end of
// the line, a quote, a closing bracket or a comma.
const headerPattern = new RegExp(`\\b(${headerAlternation})(["']?\\s*[:=]\\s*\\[?\\s*["']?)(?!\\[REDACTED\\]|REDACTED\\b)([^"'\\r\\n,\\]}]+)`, 'gi');
const tokenPattern = /([?&]token=)(?!\[REDACTED\]|REDACTED\b)[^&\s"'#<>\\]+/gi;

export const redactText = (text: string, secrets: KnownSecret[] = []): string => {
	let out = text;
	for (const s of secrets) {
		if (s.value.length < 6) continue; // never a real secret; replacing it would shred the text
		out = out.split(s.value).join(`[${s.label}]`);
		const encoded = encodeURIComponent(s.value);
		if (encoded !== s.value) out = out.split(encoded).join(`[${s.label}]`);
		const json = JSON.stringify(s.value).slice(1, -1);
		if (json !== s.value) out = out.split(json).join(`[${s.label}]`);
	}
	return out.replace(tokenPattern, `$1${redacted}`).replace(headerPattern, `$1$2${redacted}`);
};

const isCredentialHeader = (name: unknown): boolean => typeof name === 'string' && credentialHeaders.includes(name.toLowerCase());
// `{name, value}` pairs whose value is secret: credential headers, and the `token` query parameter (HAR's queryString).
const isSecretPair = (name: unknown): boolean => isCredentialHeader(name) || (typeof name === 'string' && name.toLowerCase() === 'token');

// Walks a parsed JSON value: `{name, value}` header pairs and header maps keyed by a credential header name get their
// value replaced; every other string goes through redactText.
export const redactJson = (value: unknown, secrets: KnownSecret[] = []): unknown => {
	if (typeof value === 'string') return redactText(value, secrets);
	if (Array.isArray(value)) return value.map(v => redactJson(v, secrets));
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		const pair = isSecretPair(record.name) && 'value' in record;
		for (const [key, v] of Object.entries(record)) {
			if (pair && key === 'value') out[key] = redacted;
			else if (isCredentialHeader(key)) out[key] = Array.isArray(v) ? v.map(() => redacted) : redacted;
			// HAR cookies: [{name, value}] (request and response)
			else if (key === 'cookies' && Array.isArray(v)) out[key] = v.map(c => (c !== null && typeof c === 'object' ? { ...(c as Record<string, unknown>), value: redacted } : redacted));
			else out[key] = redactJson(v, secrets);
		}
		return out;
	}
	return value;
};

// Text or JSON lines (Playwright's *.trace / *.network files, JSON resources): each line that parses as JSON is
// redacted structurally, the rest as text.
export const redactDocument = (text: string, secrets: KnownSecret[] = []): string => {
	const whole = text.trim();
	if (whole.startsWith('{') || whole.startsWith('[')) {
		try {
			return JSON.stringify(redactJson(JSON.parse(whole), secrets));
		} catch {
			// JSON lines, or not JSON at all
		}
	}
	return text.split('\n').map(line => {
		const t = line.trim();
		if (t.startsWith('{') && t.endsWith('}')) {
			try {
				return JSON.stringify(redactJson(JSON.parse(t), secrets));
			} catch {
				// not JSON
			}
		}
		return redactText(line, secrets);
	}).join('\n');
};

// Binary data (images, fonts) is left alone: anything with a NUL byte or that is not valid UTF-8.
export const looksLikeText = (data: Buffer): boolean => {
	if (data.includes(0)) return false;
	return Buffer.from(data.toString('utf8'), 'utf8').equals(data);
};

export const isZip = (data: Buffer): boolean => data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;

export const redactBuffer = (data: Buffer, secrets: KnownSecret[] = []): Buffer => {
	if (isZip(data)) {
		return writeZip(readZip(data).map(entry => ({ name: entry.name, data: redactBuffer(entry.data, secrets) })));
	}
	if (!looksLikeText(data)) return data;
	return Buffer.from(redactDocument(data.toString('utf8'), secrets), 'utf8');
};

export const redactFile = (path: string, secrets: KnownSecret[] = []): void => {
	const before = readFileSync(path);
	const after = redactBuffer(before, secrets);
	if (!after.equals(before)) writeFileSync(path, after);
};

// ---- Scanning (the self-tests use this to prove an artifact is clean) ----

export interface Leak {
	where: string;
	kind: string;
	excerpt: string;
}

const excerpt = (text: string, index: number): string => text.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, ' ');

// Every place in `text` where a token= value or a credential header value is not redacted, or a known secret or a
// forbidden pattern occurs. Header names in prose (for example "X-API-AUTH values") are not leaks: only a name
// followed by a separator and a value is.
export const findLeaks = (where: string, text: string, opts: { secrets?: KnownSecret[]; forbidden?: RegExp[] } = {}): Leak[] => {
	const leaks: Leak[] = [];
	for (const m of text.matchAll(/[?&]token=([^&\s"'#<>\\]+)/gi)) {
		if (!/^\[?REDACTED\b/.test(m[1])) leaks.push({ where, kind: 'token=', excerpt: excerpt(text, m.index ?? 0) });
	}
	for (const m of text.matchAll(new RegExp(`\\b(${headerAlternation})["']?\\s*[:=]\\s*\\[?\\s*["']?([^"'\\r\\n,\\]}]*)`, 'gi'))) {
		const value = m[2].trim();
		if (value !== '' && !/^\[?REDACTED\b/.test(value)) leaks.push({ where, kind: m[1], excerpt: excerpt(text, m.index ?? 0) });
	}
	// Structured header pairs ({"name": "X-API-AUTH", "value": "…"}), as Playwright's trace stores request headers.
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (!(t.startsWith('{') || t.startsWith('['))) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(t);
		} catch {
			continue;
		}
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) {
				v.forEach(walk);
			} else if (v !== null && typeof v === 'object') {
				const r = v as Record<string, unknown>;
				if (isSecretPair(r.name) && typeof r.value === 'string' && r.value !== '' && !/^\[?REDACTED\b/.test(r.value)) {
					leaks.push({ where, kind: `${String(r.name)} (header pair)`, excerpt: `${String(r.name)}: …` });
				}
				Object.values(r).forEach(walk);
			}
		};
		walk(parsed);
	}
	for (const s of opts.secrets ?? []) {
		if (s.value.length >= 6 && text.includes(s.value)) leaks.push({ where, kind: `secret ${s.label}`, excerpt: `[${s.label}]` });
	}
	for (const pattern of opts.forbidden ?? []) {
		for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
			leaks.push({ where, kind: `pattern ${pattern.source}`, excerpt: excerpt(text, m.index ?? 0) });
		}
	}
	return leaks;
};

// Text views of an artifact: the file itself, or every text entry of a zip (a trace), recursively.
export const textViews = (name: string, data: Buffer): { where: string; text: string }[] => {
	if (isZip(data)) return readZip(data).flatMap(e => textViews(`${name}!${e.name}`, e.data));
	return looksLikeText(data) ? [{ where: name, text: data.toString('utf8') }] : [];
};
