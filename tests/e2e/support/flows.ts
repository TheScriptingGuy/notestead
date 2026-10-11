// User flows in the web app, shared by the E2E specs and the harness self-tests that must drive the real flow
// (docs/test-plans/M1-S7.md: M1-AC21 steps 3 and 4; the C1-R1 leak scan runs the same code).
import { expect } from '@playwright/test';
import type { Account } from '../../stack/stack.ts';
import type { EncryptionSettings, JoplinWebApp } from './pages/joplinWebApp.ts';

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
	await screen.back();
	return screen;
};
