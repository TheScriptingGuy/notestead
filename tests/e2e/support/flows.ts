// User flows in the web app, shared by the E2E specs and the harness self-tests that must drive the real flow
// (docs/test-plans/M1-S7.md: M1-AC21 steps 3 and 4; the C1-R1 leak scan runs the same code).
import { expect } from '@playwright/test';
import type { Account } from '../../stack/stack.ts';
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
