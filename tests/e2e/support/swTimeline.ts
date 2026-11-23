// The timeline of upstream's service-worker self-reload and its classifier (docs/test-plans/M2-S5.md RU-12, RU-13; limitation L22).
// After an upgrade that changes serviceWorker.bundle.js, upstream's page script logs "Reloading page to make use of updated COOP/COEP
// Service Worker." and reloads the page on `updatefound`; the new worker `skipWaiting()`s and claims the page at once. Chromium either
// commits that navigation (C) or loses it (R, the L22 race). `classifySelfReload` tells them apart from the CDP events of the page and the
// container's access log, and is strict: anything but a commit or the whole signature is `unknown`. Value-free: kinds, times, ids, paths.
import type { Page } from '@playwright/test';
import { waitFor } from '../../support/poll.ts';

export interface SwEvent {
	// epoch milliseconds, when this process received the event
	t: number;
	kind: 'workerVersionUpdated' | 'frameRequestedNavigation' | 'frameStartedLoading' | 'frameNavigated' | 'frameStoppedLoading';
	versionId?: string;
	status?: string;
	runningStatus?: string;
	reason?: string;
	path?: string;
	main?: boolean;
}

export interface LogEntry { method: string; path: string; status: number; ts: number }

export const updatedWorkerLine = 'Reloading page to make use of updated COOP/COEP Service Worker.';

const pathOf = (url: string): string => {
	try {
		return new URL(url).pathname || url;
	} catch {
		return url;
	}
};

// A CDP session on the page: every worker version update and the page's navigation events from now on. `stop` detaches.
export const recordSwTimeline = async (page: Page): Promise<{ events: SwEvent[]; stop: () => Promise<void> }> => {
	const events: SwEvent[] = [];
	const cdp = await page.context().newCDPSession(page);
	cdp.on('ServiceWorker.workerVersionUpdated', (e: { versions: { versionId: string; status: string; runningStatus: string }[] }) => {
		for (const v of e.versions) events.push({ t: Date.now(), kind: 'workerVersionUpdated', versionId: v.versionId, status: v.status, runningStatus: v.runningStatus });
	});
	cdp.on('Page.frameRequestedNavigation', (e: { reason: string; url: string }) => events.push({ t: Date.now(), kind: 'frameRequestedNavigation', reason: e.reason, path: pathOf(e.url) }));
	cdp.on('Page.frameStartedLoading', () => events.push({ t: Date.now(), kind: 'frameStartedLoading' }));
	cdp.on('Page.frameNavigated', (e: { frame: { url: string; parentId?: string } }) => events.push({ t: Date.now(), kind: 'frameNavigated', path: pathOf(e.frame.url), main: e.frame.parentId === undefined }));
	cdp.on('Page.frameStoppedLoading', () => events.push({ t: Date.now(), kind: 'frameStoppedLoading' }));
	await cdp.send('ServiceWorker.enable');
	await cdp.send('Page.enable');
	return { events, stop: async () => { await cdp.detach().catch(() => undefined); } };
};

// Tolerance for the order of two events received within a few milliseconds of each other.
const slack = 100;

export const classifySelfReload = (events: SwEvent[], accessEntries: LogEntry[], lineTime: number, windowMs = 60_000): { outcome: 'committed' | 'race' | 'unknown'; parts: string[] } => {
	const end = lineTime + windowMs;
	const inWindow = events.filter(e => e.t >= lineTime - slack && e.t <= end);
	const navigations = inWindow.filter(e => e.kind === 'frameNavigated' && e.main === true && e.path !== 'blank' && e.t >= lineTime);
	const rootRequests = accessEntries.filter(e => e.method === 'GET' && e.path === '/' && e.ts >= lineTime && e.ts <= end);
	if (navigations.length > 0 && rootRequests.length > 0) return { outcome: 'committed', parts: ['main-frame navigation committed after the line', 'GET / after the line'] };

	const request = inWindow.find(e => e.kind === 'frameRequestedNavigation' && e.reason === 'reload');
	const after = request ? inWindow.filter(e => e.t >= request.t) : [];
	const redundant = after.find(e => e.kind === 'workerVersionUpdated' && e.status === 'redundant');
	const taking = redundant ? after.find(e => e.kind === 'workerVersionUpdated' && (e.status === 'activating' || e.status === 'activated') && e.versionId !== redundant.versionId) : undefined;
	const parts = [
		`(i) a reload navigation was requested after the line: ${request ? 'seen' : 'missing'}`,
		`(ii) afterwards the old version went redundant and the new one activating or activated: ${redundant && taking ? 'seen' : 'missing'}`,
		`(iii) no main-frame navigation committed within ${windowMs} ms: ${navigations.length === 0 ? 'seen' : `missing (${navigations.length} committed)`}`,
		`(iv) no GET / reached the container after the line: ${rootRequests.length === 0 ? 'seen' : `missing (${rootRequests.length} requests)`}`,
	];
	const race = !!request && !!redundant && !!taking && navigations.length === 0 && rootRequests.length === 0;
	return { outcome: race ? 'race' : 'unknown', parts };
};

export type ReloadOutcome = { state: 'resolved' } | { state: 'rejected'; message: string };

// RU-15: the user's reload of a tab stuck by the L22 race. Playwright's promise is an unreliable witness there (the reload replaces the
// stuck self-reload navigation and can reject with `net::ERR_ABORTED`), so the commit is judged from the browser (a main-frame
// navigation to the app after `t0`) and the server (a GET / after `t0`). `net::ERR_ABORTED` is accepted, together with that evidence and
// recorded; any other rejection fails, named.
export const judgeUserReload = (outcome: ReloadOutcome, events: SwEvent[], accessEntries: LogEntry[], t0: number): { committed: boolean; parts: string[] } => {
	const navigated = events.some(e => e.kind === 'frameNavigated' && e.main === true && e.path !== 'blank' && e.t >= t0);
	const served = accessEntries.some(e => e.method === 'GET' && e.path === '/' && e.ts >= t0);
	const parts: string[] = [
		outcome.state === 'resolved' ? 'promise: resolved' : outcome.message.includes('net::ERR_ABORTED') ? 'promise: ERR_ABORTED (replaced the stuck self-reload)' : `promise: rejected with ${outcome.message.split('\n')[0]}`,
		`main-frame navigation to the app after the reload: ${navigated ? 'seen' : 'missing'}`,
		`GET / after the reload: ${served ? 'seen' : 'missing'}`,
	];
	const promiseOk = outcome.state === 'resolved' || outcome.message.includes('net::ERR_ABORTED');
	return { committed: promiseOk && navigated && served, parts };
};

// Starts one `page.reload()` and waits, by polling, for its commit evidence; returns once the promise has settled too, so nothing is
// still running in the tab. Nothing else is started in the tab meanwhile.
export const userReload = async (page: Page, events: SwEvent[], accessLog: () => Promise<LogEntry[]>, opts: { timeoutMs: number }): Promise<{ committed: boolean; parts: string[]; ms: number }> => {
	const t0 = Date.now();
	let settled: ReloadOutcome | undefined;
	const promise = page.reload({ timeout: opts.timeoutMs }).then((): ReloadOutcome => ({ state: 'resolved' }), (e: Error): ReloadOutcome => ({ state: 'rejected', message: e.message }));
	void promise.then(o => { settled = o; });
	try {
		await waitFor('the user reload to commit', async () => {
			if (settled?.state === 'rejected' && !settled.message.includes('net::ERR_ABORTED')) return true;
			return judgeUserReload(settled ?? { state: 'resolved' }, events, await accessLog(), t0).committed ? true : undefined;
		}, { timeoutMs: opts.timeoutMs, intervalMs: 500 });
	} catch {
		// the verdict below names what is missing
	}
	const final = await promise;
	return { ...judgeUserReload(final, events, await accessLog(), t0), ms: Date.now() - t0 };
};
