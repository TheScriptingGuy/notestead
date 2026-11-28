// Browser state probes of the service worker and its cache (docs/test-plans/M2-S5.md D5). Values only: paths, digests, markers,
// never note text. Each reads in the app's page (or any same-origin page of the context). Upstream's page script reloads the page
// itself when the worker updates (serviceWorker.ts:272-280), so a read that meets a navigation is repeated, for at most 30 s.
import { waitFor, withTimeout } from '../../support/poll.ts';
import type { NetEntry } from './network.ts';
import type { Page } from '@playwright/test';

// upstream:packages/app-mobile/web/serviceWorker.ts:145-164 (`cacheResponse`): a same-origin GET with an ok response is put in the
// Cache Storage cache `v1` when its path ends in one of these extensions or its content type is text/html.
export const cacheName = 'v1';
export const cachedPathPattern = /\.(js|css|wasm|json|ttf|html|png)$/;

const navigating = /Execution context was destroyed|frame was detached|Cannot find context with specified id|navigation|did not answer within/i;

const inPage = async <T>(page: Page, what: string, read: () => Promise<T>): Promise<T> => {
	return waitFor(what, async () => {
		try {
			// bounded: an evaluation in a frame stuck in a navigation (L22) never returns, and the poll cannot interrupt it
			return await withTimeout(what, read(), 10_000);
		} catch (error) {
			if (navigating.test((error as Error).message)) return undefined;
			throw error;
		}
	}, { timeoutMs: 30_000, intervalMs: 250 });
};

// The script URL of the worker that controls the page, or null.
export const swController = (page: Page): Promise<string | null> => inPage(page, 'the service-worker controller', () => page.evaluate(() => {
	const g = globalThis as unknown as { navigator: { serviceWorker?: { controller: { scriptURL: string } | null } } };
	return g.navigator.serviceWorker?.controller?.scriptURL ?? null;
}));

// The scopes of the origin's service-worker registrations.
export const swRegistrations = (page: Page): Promise<string[]> => inPage(page, 'the service-worker registrations', () => page.evaluate(async () => {
	const g = globalThis as unknown as { navigator: { serviceWorker?: { getRegistrations: () => Promise<{ scope: string }[]> } } };
	return (await (g.navigator.serviceWorker?.getRegistrations() ?? Promise.resolve([]))).map(r => r.scope).sort();
}));

// The paths (no query) of the requests in Cache Storage `name`; [] when the cache does not exist (it is never created by the probe).
export const swCacheKeys = (page: Page, name = cacheName): Promise<string[]> => inPage(page, 'the Cache Storage keys', () => page.evaluate(async n => {
	const g = globalThis as unknown as { caches: { keys: () => Promise<string[]>; open: (n: string) => Promise<{ keys: () => Promise<{ url: string }[]> }> } };
	if (!(await g.caches.keys()).includes(n)) return [];
	const cache = await g.caches.open(n);
	return [...new Set((await cache.keys()).map(r => new URL(r.url).pathname))].sort();
}, name));

// The names of every Cache Storage cache of the origin.
export const swCacheNames = (page: Page): Promise<string[]> => inPage(page, 'the Cache Storage names', () => page.evaluate(async () => {
	const g = globalThis as unknown as { caches: { keys: () => Promise<string[]> } };
	return (await g.caches.keys()).sort();
}));

// The sha256 and size of the body cached for `path` (no query), or undefined when it is not cached.
export const swCachedDigest = async (page: Page, path: string, name = cacheName): Promise<{ sha256: string; size: number } | undefined> =>
	(await inPage(page, `the cached digest of ${path}`, () => page.evaluate(async ([n, p]) => {
		const g = globalThis as unknown as {
			caches: { keys: () => Promise<string[]>; open: (n: string) => Promise<{ keys: () => Promise<{ url: string }[]>; match: (r: { url: string }) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | undefined> }> };
			crypto: { subtle: { digest: (a: string, d: ArrayBuffer) => Promise<ArrayBuffer> } };
		};
		if (!(await g.caches.keys()).includes(n)) return null;
		const cache = await g.caches.open(n);
		const request = (await cache.keys()).find(r => new URL(r.url).pathname === p);
		if (!request) return null;
		const body = await (await cache.match(request))?.arrayBuffer();
		if (!body) return null;
		const digest = new Uint8Array(await g.crypto.subtle.digest('SHA-256', body));
		return { sha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join(''), size: body.byteLength };
	}, [name, path] as const))) ?? undefined;

// The test marker of the bundle the page started from (`globalThis.notesteadTestBundle`, environment.js of B, B2 and O), or null.
export const bundleMarker = (page: Page): Promise<string | null> => inPage(page, 'the bundle marker', () => page.evaluate(() => {
	const g = globalThis as unknown as { notesteadTestBundle?: unknown };
	return typeof g.notesteadTestBundle === 'string' ? g.notesteadTestBundle : null;
}));

// The paths of every same-origin GET of a load that was answered 200 and that upstream's worker caches: a path with a cached
// extension, or a document (the page itself, `/`). Requests the worker made itself are the same paths and add nothing.
export const cacheableLoadPaths = (entries: NetEntry[], origin: string): string[] => {
	const paths = new Set<string>();
	for (const e of entries) {
		if (e.method !== 'GET' || e.status !== 200) continue;
		let url: URL;
		try {
			url = new URL(e.url);
		} catch {
			continue;
		}
		if (url.origin !== origin) continue;
		if (cachedPathPattern.test(url.pathname) || e.resourceType === 'document') paths.add(url.pathname);
	}
	return [...paths].sort();
};
