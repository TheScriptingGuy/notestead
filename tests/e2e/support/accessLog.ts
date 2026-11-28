// The access log of a test's own `web` container, parsed from the JSON lines Caddy writes on stdout (docs/test-plans/M2-S5.md D4).
// The query string is dropped (the Data API token travels in it; CLAUDE.md redaction rule). Pure: unit-tested (al-01…04).
export interface AccessEntry { method: string; path: string; status: number; ts: number }

// `ts` is the entry's time in epoch milliseconds (Caddy logs seconds with a fraction).
export const parseAccessLog = (text: string): AccessEntry[] => {
	const entries: AccessEntry[] = [];
	for (const line of text.split('\n')) {
		if (!line.startsWith('{')) continue;
		let parsed: { logger?: unknown; ts?: unknown; status?: unknown; request?: { method?: unknown; uri?: unknown } };
		try {
			parsed = JSON.parse(line) as typeof parsed;
		} catch {
			continue;
		}
		if (typeof parsed.logger !== 'string' || !parsed.logger.startsWith('http.log.access')) continue;
		const { method, uri } = parsed.request ?? {};
		if (typeof method !== 'string' || typeof uri !== 'string' || typeof parsed.status !== 'number' || typeof parsed.ts !== 'number') continue;
		entries.push({ method, path: uri.split('?')[0], status: parsed.status, ts: Math.round(parsed.ts * 1000) });
	}
	return entries;
};
