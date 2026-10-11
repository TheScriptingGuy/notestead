// Page objects for upstream's Joplin web app (packages/app-mobile `yarn web`, react-native-web DOM) as served by the
// `web` container (ADR-0001, ADR-0007; docs/test-plans/M1-S7.md §Page objects). Modelled on the role-based models of
// upstream's desktop integration tests (packages/app-desktop/integration-tests/models), written for this DOM; no
// upstream code is copied. Locators use roles and accessible names (react-native-web maps accessibilityRole,
// accessibilityLabel and accessibilityLabelledBy to ARIA); the strings are upstream's en_GB UI texts at the pinned ref.
// Every text goes in through typeLikeUser (real key events; secrets only into password fields, C1-R1).
import type { Locator, Page } from '@playwright/test';
import { typeLikeUser } from '../typeLikeUser.ts';

// The first start on the Pi takes ~15 s ("Application is ready" in the console) before the first screen is usable.
export const appStartTimeoutMs = 3 * 60_000;

export const decryptionBannerText = 'Press to set the decryption password.';

export class JoplinWebApp {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	// A fresh profile shows upstream's sync wizard first (`sync.wizard.autoShowOnStartup`).
	public async open(origin: string): Promise<void> {
		await this.page.goto(origin);
		await this.syncWizard().waitFor({ timeout: appStartTimeoutMs });
	}

	public syncWizard(): Locator {
		return this.page.getByRole('dialog').filter({ has: this.page.getByRole('heading', { name: 'Synchronisation', exact: true }) });
	}

	// The wizard's "Other" card opens the Synchronisation section of the configuration screen.
	public async chooseOtherSyncTarget(): Promise<SyncSettings> {
		await this.syncWizard().getByRole('button', { name: /^Other\b/ }).click();
		const settings = new SyncSettings(this.page);
		await settings.targetButton().waitFor();
		return settings;
	}

	// The main screen's warning banner that opens the encryption screen (WarningBanner `showMissingMasterKeyMessage`).
	public decryptionBanner(): Locator {
		return this.page.getByRole('button', { name: decryptionBannerText, exact: true });
	}

	public async openEncryptionSettingsFromBanner(): Promise<EncryptionSettings> {
		await this.decryptionBanner().click();
		const screen = new EncryptionSettings(this.page);
		await screen.heading().waitFor();
		return screen;
	}

	// A note in the note list (each note is a button named by its title).
	public noteInList(title: string): Locator {
		return this.page.getByRole('button', { name: title, exact: true });
	}

	// Anywhere in the DOM, visible or not (for absence checks: any trace of the title counts).
	public anyTextOf(text: string): Locator {
		return this.page.getByText(text, { exact: false });
	}

	public sidebarButton(): Locator {
		return this.page.getByRole('button', { name: 'Sidebar', exact: true });
	}

	public async openSidebar(): Promise<void> {
		await this.sidebarButton().click();
		await this.page.getByRole('button', { name: /^(Synchronise|Cancel)$/ }).waitFor();
	}

	public async closeSidebar(): Promise<void> {
		await this.page.getByRole('button', { name: 'Close side menu', exact: true }).click();
	}

	// The side menu's sync report (Synchronizer.reportToLines: "Completed: …", "Last error: …"); '' when none is shown.
	public async syncReport(): Promise<string> {
		const report = this.page.getByText(/^Completed: /);
		return (await report.count()) > 0 ? (await report.first().innerText()) : '';
	}
}

export class SyncSettings {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public targetButton(): Locator {
		return this.page.getByText('Synchronisation target', { exact: true });
	}

	public async selectJoplinServer(): Promise<void> {
		// The dropdown button is named by the current target ("(None)" on a fresh profile).
		await this.page.getByRole('button', { name: '(None)', exact: true }).click();
		await this.page.getByRole('menuitem', { name: 'Joplin Server', exact: true }).click();
		await this.page.getByLabel('Joplin Server URL', { exact: true }).waitFor();
	}

	public async enterJoplinServer(url: string, email: string, password: string): Promise<void> {
		await typeLikeUser(this.page.getByLabel('Joplin Server URL', { exact: true }), url);
		await typeLikeUser(this.page.getByLabel('Joplin Server email', { exact: true }), email);
		await typeLikeUser(this.page.getByLabel('Joplin Server password', { exact: true }), password, { secret: true });
	}

	public saveButton(): Locator {
		return this.page.getByRole('button', { name: 'Save changes', exact: true });
	}

	// Save, then back to the note list. The app starts a sync by itself a few seconds after the target changed.
	public async saveAndGoBack(): Promise<void> {
		await this.saveButton().click();
		await this.page.getByRole('button', { name: 'Save changes', exact: true, disabled: true }).waitFor();
		await this.page.getByRole('button', { name: 'Back', exact: true }).click();
	}
}

export class EncryptionSettings {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public heading(): Locator {
		return this.page.getByRole('heading', { name: 'Encryption Config', exact: true });
	}

	// The block of the (only) enabled master key: heading "Master Key <id>", "Password:", a password field, Save.
	public masterKeySection(): Locator {
		return this.page.locator('div').filter({ has: this.page.getByRole('heading', { name: /^Master Key [0-9a-f]{6}$/ }) }).last();
	}

	public async enterMasterPassword(masterPassword: string): Promise<void> {
		const section = this.masterKeySection();
		await typeLikeUser(section.getByRole('textbox'), masterPassword, { secret: true });
		await section.getByRole('button', { name: 'Save', exact: true }).click();
	}

	// After a correct password the key's row shows "(Master password)" instead of the field.
	public acceptedMarker(): Locator {
		return this.masterKeySection().getByText('(Master password)', { exact: true });
	}

	public async back(): Promise<void> {
		await this.page.getByRole('button', { name: 'Back', exact: true }).click();
	}
}
