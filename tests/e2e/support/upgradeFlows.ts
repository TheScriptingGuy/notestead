// Shared steps of the M2-S5 specs (docs/test-plans/M2-S5.md): every test runs its own `web` container of the image under test on a
// port of its own and one browser context on that origin, so redeploying `web` never touches the shared stack's (F8).
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { expect } from '@playwright/test';
import { freePort, podmanSync } from '../../stack/stack.ts';
import { holdsFor, waitFor } from '../../support/poll.ts';
import type { Account, ExtraWeb, HeadlessService, StackState } from '../../stack/stack.ts';
import { ok } from './dataApi.ts';
import { openUnlockedWebApp } from './flows.ts';
import { expectStoredLocally } from './localProfile.ts';
import { connectionCheckUrl, endOfTestViolations } from './network.ts';
import { JoplinWebApp, NoteScreen } from './pages/joplinWebApp.ts';
import type { AppContext, AppContexts, DataApi, DownWeb, ExtraWebs } from './fixtures.ts';
import { swCacheKeys } from './swState.ts';
import type { TestBundles } from './testBundles.ts';

export interface Fixtures {
	stack: StackState;
	e2eeAccount: Account;
	extraWebs: ExtraWebs;
	appContexts: AppContexts;
	testBundles: TestBundles;
}

export interface Started { web: ExtraWeb; ctx: AppContext; app: JoplinWebApp; origin: string; seedFolder: string; notes: { id: string; title: string; body: string }[] }

// A fresh `web` serving bundle A on a free port, a fresh context on its origin, the web app configured and unlocked.
export const startUnlocked = async (fx: Fixtures, label: string): Promise<Started> => {
	const seedFolder = fx.e2eeAccount.folder;
	const notes = fx.e2eeAccount.notes ?? [];
	if (!seedFolder || notes.length === 0) throw new Error('the account has no seeded folder and notes');
	const port = await freePort();
	const web = await fx.extraWebs.start({ role: 'web-extra', port, mountDist: fx.testBundles.a });
	const ctx = await fx.appContexts.open(web.url, label);
	const app = new JoplinWebApp(ctx.page);
	await openUnlockedWebApp(app, web.url, `${web.url}/joplin-server`, fx.e2eeAccount);
	return { web, ctx, app, origin: new URL(web.url).origin, seedFolder, notes };
};

// A token typed into a note like a user: `nst` and 12 hex digits, never a secret.
export const newToken = (): string => `nst${randomBytes(6).toString('hex')}`;

// Appends ` <token>` to the body of the seeded note `title`, goes back to the list, and waits for the app's own database to hold it.
export const typeIntoNote = async (s: Started, title: string, token: string, what: string): Promise<void> => {
	const note = new NoteScreen(s.ctx.page);
	await s.app.openFolder(s.seedFolder);
	await s.app.openNote(title);
	await note.waitOpen();
	await note.typeBody(` ${token}`);
	await s.app.backToList();
	await expectStoredLocally(s.ctx, token, what);
};

export const restBody = (dataApi: DataApi, id: string): string => String(ok(dataApi.get(`/notes/${id}?fields=id,body`), 'GET /notes/:id').body);

// The network policy over the whole test for this context, with the L15 connection check allowed (M2-AC1).
export const expectNetworkPolicy = (s: Started): void => {
	expect(endOfTestViolations(s.ctx.network.entries(), s.origin, [connectionCheckUrl]), 'network policy over the whole test').toEqual([]);
};

export type { HeadlessService };

// RU-3: the app is quiet before the web container goes away: a window of 5 s without a new access-log entry, found within 120 s. The
// caller has completed its last web sync first. A failure names the last entries (method and path); it is never answered with a longer
// window.
export const quiesce = async (extraWebs: ExtraWebs, web: ExtraWeb): Promise<void> => {
	const count = async (): Promise<number> => (await extraWebs.accessLog(web)).length;
	try {
		await waitFor('the web container to see no request for 5 s', async () => {
			const before = await count();
			try {
				await holdsFor('the web container sees no request', async () => ((await count()) > before ? 'a request arrived' : undefined), { windowMs: 5_000, intervalMs: 500 });
				return true;
			} catch {
				return undefined;
			}
		}, { timeoutMs: 120_000, intervalMs: 100 });
	} catch {
		const last = (await extraWebs.accessLog(web)).slice(-5).map(e => `${e.method} ${e.path}`);
		throw new Error(`quiesce: the web container was not quiet for 5 s within 120 s (RU-3 HARD STOP); the last entries: ${last.join(', ')}`);
	}
};

// RU-2: going offline = quiesce, `/manifest.json` in Cache Storage (the OPFS probe page of localProfile.ts is a navigation too), the
// test's own `web` container stopped and removed, then the context offline (and `navigator.onLine` false in the page).
export const goOffline = async (fx: Fixtures, s: Started): Promise<DownWeb> => {
	await quiesce(fx.extraWebs, s.web);
	expect(await s.ctx.page.evaluate(async () => (await fetch('/manifest.json')).status), 'the probe page is available online').toBe(200);
	await expect.poll(async () => (await swCacheKeys(s.ctx.page)).includes('/manifest.json'), { timeout: 60_000, intervals: [500], message: 'the probe page is in Cache Storage v1' }).toBe(true);
	const down = fx.extraWebs.down(s.web);
	await s.ctx.context.setOffline(true);
	expect(await s.ctx.page.evaluate(() => (globalThis as unknown as { navigator: { onLine: boolean } }).navigator.onLine), 'the page is offline').toBe(false);
	return down;
};

// RU-2: back online = a new `web` on the same port (with the bundle to serve), then the context online.
export const goOnline = async (fx: Fixtures, s: Started, down: DownWeb, opts: { mountDist?: string }): Promise<ExtraWeb> => {
	s.web = await fx.extraWebs.up(down, opts);
	await s.ctx.context.setOffline(false);
	return s.web;
};

// RU-2 guard: no response can come from our server. The container is gone and nothing listens on its port (a connect is refused).
export const serverUnreachable = async (down: DownWeb): Promise<string> => {
	expect(podmanSync(['container', 'exists', down.container], { allowFail: true }).code, `the web container ${down.container} is gone`).not.toBe(0);
	const outcome = await new Promise<string>(resolve => {
		const socket = connect({ host: '127.0.0.1', port: down.port });
		socket.setTimeout(5_000, () => { socket.destroy(); resolve('timeout'); });
		socket.once('connect', () => { socket.destroy(); resolve('connected'); });
		socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
	});
	expect(outcome, `a connection to 127.0.0.1:${down.port} is refused`).toBe('ECONNREFUSED');
	return outcome;
};

// RU-1 step 5: the new container has seen nothing but the harness's own readiness `GET /` before the app's one online load.
export const expectOnlyReadiness = async (extraWebs: ExtraWebs, web: ExtraWeb): Promise<number> => {
	const log = await extraWebs.accessLog(web);
	const other = log.filter(e => !(e.method === 'GET' && e.path === '/')).map(e => `${e.method} ${e.path}`);
	expect(other, 'the new container saw only the readiness GET / before the load (no upload from the old app)').toEqual([]);
	return log.length;
};
