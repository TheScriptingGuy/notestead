// The network policy of the web app and a recorder of everything a browser context requests (docs/test-plans/M2-S1.md,
// Interpretations 2 and 3). The recorder only observes: it never routes or aborts a request, because routing would change
// upstream's behaviour (Playwright routes skip requests a service worker handles).
//   - Every request to the sync target is same-origin and under /joplin-server/api/.
//   - The sole cross-origin request allowed is exactly `HEAD https://joplinapp.org/connection_check/`.
//   - data:, blob: and about: URLs are local and ignored.
//   - Everything else is a violation. Violation lines carry no query string (the Data API token and session ids travel there).
import type { BrowserContext, Request } from '@playwright/test';

export interface NetEntry {
	at: string;
	method: string;
	url: string;
	resourceType: string;
	fromServiceWorker: boolean;
	status?: number;
	failure?: string;
}

export interface NetVerdict {
	// same-origin, path under /joplin-server/api/
	syncTraffic: NetEntry[];
	// same-origin, not under /joplin-server/
	sameOriginOther: NetEntry[];
	// exactly HEAD https://joplinapp.org/connection_check/
	allowedExternal: NetEntry[];
	// data:, blob:, about: (local)
	ignored: NetEntry[];
	violations: { entry: NetEntry; why: string }[];
}

export const connectionCheckUrl = 'https://joplinapp.org/connection_check/';
const syncApiPrefix = '/joplin-server/api/';

export const classifyRequests = (entries: NetEntry[], appOrigin: string): NetVerdict => {
	const verdict: NetVerdict = { syncTraffic: [], sameOriginOther: [], allowedExternal: [], ignored: [], violations: [] };
	for (const entry of entries) {
		let url: URL;
		try {
			url = new URL(entry.url);
		} catch {
			verdict.violations.push({ entry, why: 'unparsable URL' });
			continue;
		}
		if (['data:', 'blob:', 'about:'].includes(url.protocol)) {
			verdict.ignored.push(entry);
		} else if (url.protocol === 'http:' && url.origin === appOrigin) {
			let path = url.pathname;
			try {
				path = decodeURIComponent(path);
			} catch {
				// keep the raw path
			}
			if (path.startsWith(syncApiPrefix)) verdict.syncTraffic.push(entry);
			else if (path === '/joplin-server' || path.startsWith('/joplin-server/')) verdict.violations.push({ entry, why: 'same-origin request to the sync target outside /joplin-server/api/' });
			else verdict.sameOriginOther.push(entry);
		} else if (entry.method === 'HEAD' && entry.url === connectionCheckUrl) {
			verdict.allowedExternal.push(entry);
		} else {
			verdict.violations.push({ entry, why: 'cross-origin request' });
		}
	}
	return verdict;
};

// `${method} ${origin}${pathname}: ${why}`, no query string.
export const violationLines = (v: NetVerdict): string[] => v.violations.map(({ entry, why }) => {
	let where = '(unparsable URL)';
	try {
		const url = new URL(entry.url);
		where = `${url.origin}${url.pathname}`;
	} catch {
		// keep the placeholder
	}
	return `${entry.method} ${where}: ${why}`;
});

export interface NetworkRecorder {
	entries: () => NetEntry[];
	text: () => string;
}

const withoutQuery = (url: string): string => url.replace(/\?[^#]*/, '?[query]');

export const recordNetwork = (context: BrowserContext): NetworkRecorder => {
	const list: NetEntry[] = [];
	const byRequest = new Map<Request, NetEntry>();
	context.on('request', r => {
		const entry: NetEntry = { at: new Date().toISOString(), method: r.method(), url: r.url(), resourceType: r.resourceType(), fromServiceWorker: !!r.serviceWorker() };
		list.push(entry);
		byRequest.set(r, entry);
	});
	context.on('response', r => {
		const entry = byRequest.get(r.request());
		if (entry) entry.status = r.status();
	});
	context.on('requestfailed', r => {
		const entry = byRequest.get(r);
		if (entry) entry.failure = r.failure()?.errorText;
	});
	return {
		entries: () => list.map(e => ({ ...e })),
		text: () => list.map(e => [e.at, e.method, withoutQuery(e.url), e.resourceType, e.fromServiceWorker ? 'sw' : 'page', e.status ?? '', e.failure ?? ''].join(' ').trimEnd()).join('\n'),
	};
};
