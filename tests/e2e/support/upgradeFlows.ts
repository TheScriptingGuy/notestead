// Shared steps of the M2-S5 specs (docs/test-plans/M2-S5.md): every test runs its own `web` container of the image under test on a
// port of its own and one browser context on that origin, so redeploying `web` never touches the shared stack's (F8).
import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { freePort } from '../../stack/stack.ts';
import type { Account, ExtraWeb, HeadlessService, StackState } from '../../stack/stack.ts';
import { ok } from './dataApi.ts';
import { openUnlockedWebApp } from './flows.ts';
import { expectStoredLocally } from './localProfile.ts';
import { connectionCheckUrl, endOfTestViolations } from './network.ts';
import { JoplinWebApp, NoteScreen } from './pages/joplinWebApp.ts';
import type { AppContext, AppContexts, DataApi, ExtraWebs } from './fixtures.ts';
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
