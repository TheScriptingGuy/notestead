// User flows in the web app, shared by the E2E specs and the harness self-tests that must drive the real flow
// (docs/test-plans/M1-S7.md: M1-AC21 steps 3 and 4; the C1-R1 leak scan runs the same code).
import { expect } from '@playwright/test';
import { syncHeadlessOnce } from '../../stack/stack.ts';
import type { Account, HeadlessService, StackState } from '../../stack/stack.ts';
import type { NetworkRecorder } from './network.ts';
import type { EncryptionSettings, JoplinWebApp, SyncSettings } from './pages/joplinWebApp.ts';

// The app's own first sync after the target changed downloads the master key, and the decryption banner appears
// (~10 s on the Pi from "Back"; the sync itself ~2 s).
export const firstSyncTimeoutMs = 3 * 60_000;

// M1-AC21 step 3: a fresh profile (fresh BrowserContext), from the first-start wizard to a saved Joplin Server target.
// Returns once the settings are saved and the note list is back; the app then syncs by itself.
export const configureJoplinServerSync = async (app: JoplinWebApp, origin: string, syncUrl: string, account: Account): Promise<void> => {
	await app.open(origin);
	const settings = await app.chooseOtherSyncTarget();
	await settings.selectJoplinServer();
	await settings.enterJoplinServer(syncUrl, account.email, account.password);
	await settings.saveAndGoBack();
};

// M1-AC21 step 4: from the decryption banner, the master password into the master key's (masked) field.
export const unlockE2ee = async (app: JoplinWebApp, account: Account): Promise<EncryptionSettings> => {
	const screen = await app.openEncryptionSettingsFromBanner();
	await screen.enterMasterPassword(account.masterPassword);
	await expect(screen.acceptedMarker(), 'the master password was accepted').toBeVisible({ timeout: 60_000 });
	// The marker also shows after a wrong password (docs/test-plans/M2-S1.md Finding F1): the state tells them apart.
	await expect.poll(() => screen.masterPasswordState(), { timeout: 60_000, intervals: [500] }).toBe('accepted');
	await screen.back();
	return screen;
};

// M2-AC1: the same configuration screen, then upstream's "Check synchronisation configuration" button. Returns once the
// check has an outcome (success or error), still on the configuration screen: the caller asserts which.
export const configureAndCheckJoplinServerSync = async (app: JoplinWebApp, origin: string, syncUrl: string, account: Account, opts: { password?: string } = {}): Promise<SyncSettings> => {
	await app.open(origin);
	const settings = await app.chooseOtherSyncTarget();
	await settings.selectJoplinServer();
	await settings.enterJoplinServer(syncUrl, account.email, opts.password ?? account.password);
	await settings.checkButton().click();
	await expect.poll(() => settings.configCheckStatus(), { timeout: 60_000, intervals: [500] }).not.toMatch(/^(none|checking)$/);
	return settings;
};

// L18: on an E2EE account nothing syncs before the master password, so every M2-S2 test unlocks first and waits for the
// first seeded note (docs/test-plans/M2-S2.md D1).
export const openUnlockedWebApp = async (app: JoplinWebApp, origin: string, syncUrl: string, account: Account): Promise<void> => {
	const first = account.notes?.[0];
	if (!first) throw new Error('openUnlockedWebApp needs an account with a seeded note');
	await configureJoplinServerSync(app, origin, syncUrl, account);
	await expect(app.decryptionBanner(), 'the web app synced and asks for the master password').toBeVisible({ timeout: firstSyncTimeoutMs });
	await unlockE2ee(app, account);
	await expect.poll(() => app.noteInList(first.title).isVisible(), { timeout: 3 * 60_000, intervals: [1_000] }).toBe(true);
};

export const deltaPath = '/joplin-server/api/items/root:/:/delta';

const decodedPath = (url: string): string => {
	const path = new URL(url).pathname;
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
};

// One web sync (docs/test-plans/M2-S2.md D3), from the note list: idle first, one press of Synchronise, then a delta
// request after the press, idle again, and a report with Completed: and no Last error:. Upstream runs update_remote
// before delta, so a delta after the press means that sync's upload ran after the caller's change. Ends with the side
// menu closed.
export const syncWebOnce = async (app: JoplinWebApp, network: NetworkRecorder, timeoutMs = 3 * 60_000): Promise<{ report: string; durationMs: number }> => {
	const started = Date.now();
	await app.openSidebar();
	await expect(app.syncIdle(), 'no sync running before the web sync').toBeVisible({ timeout: timeoutMs });
	const mark = network.entries().length;
	await app.syncIdle().click();
	let report = '';
	await expect.poll(async () => {
		const deltaSeen = network.entries().slice(mark).some(e => e.method === 'GET' && e.status === 200 && decodedPath(e.url) === deltaPath);
		if (!deltaSeen) return 'no delta request since the press';
		if (!(await app.syncIdle().isVisible())) return 'a sync is running';
		report = await app.syncReport();
		if (/Last error:/.test(report)) return `the sync reported an error: ${report}`;
		return /\bCompleted: /.test(report) ? 'completed' : `no completed report yet: ${JSON.stringify(report)}`;
	}, { timeout: timeoutMs, intervals: [1_000] }).toBe('completed');
	await app.closeSidebar();
	return { report, durationMs: Date.now() - started };
};

// One web sync, then one headless sync of the test's own service (D2, D3): one "cycle" of M2-S2.
export const syncWebThenHeadless = async (app: JoplinWebApp, network: NetworkRecorder, stack: StackState, service: HeadlessService): Promise<{ webMs: number; headlessMs: number; webReport: string }> => {
	const web = await syncWebOnce(app, network);
	const headless = await syncHeadlessOnce(stack, service);
	return { webMs: web.durationMs, headlessMs: headless.durationMs, webReport: web.report };
};
