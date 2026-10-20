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
	// The report is one text element whose lines are joined with newlines, and "Completed:" comes after any "Created …" or
	// "Updated …" lines, so the match is not anchored (docs/test-plans/M2-S1.md Finding F2).
	public async syncReport(): Promise<string> {
		const report = this.page.getByText(/\bCompleted: /);
		return (await report.count()) > 0 ? (await report.first().innerText()) : '';
	}

	// The side menu's sync button reads "Synchronise" while no sync runs ("Cancel" while one does).
	public syncIdle(): Locator {
		return this.page.getByRole('button', { name: 'Synchronise', exact: true });
	}

	// Notes whose items are not decrypted yet are listed under upstream's `BaseItem.displayTitle` placeholder.
	public encryptedNotesInList(): Locator {
		return this.page.getByRole('button', { name: '🔑 Encrypted', exact: true });
	}

	// A folder in the side menu (open it with openSidebar): a button whose accessibility label is the title at depth 0.
	public folderInSideMenu(title: string): Locator {
		return this.page.getByRole('button', { name: title, exact: true });
	}

	public async openNote(title: string): Promise<void> {
		await this.noteInList(title).click();
	}

	public async backToList(): Promise<void> {
		await this.page.getByRole('button', { name: 'Back', exact: true }).click();
		await this.sidebarButton().waitFor();
	}

	// The HTML of the page and of every frame, for absence checks (it holds attributes such as aria-label and hidden text).
	// The note viewer is a sandboxed srcdoc iframe (ExtendedWebView/index.web.tsx), so the page's own DOM never holds a body.
	public async frameHtml(): Promise<string> {
		return (await this.perFrame('html')).join('\n');
	}

	// The rendered text of the page and of every frame, for presence checks of a note body.
	public async frameText(): Promise<string> {
		return (await this.perFrame('text')).join('\n');
	}

	private async perFrame(what: 'html' | 'text'): Promise<string[]> {
		return Promise.all(this.page.frames().map(async frame => {
			try {
				return await frame.evaluate(w => {
					const doc = (globalThis as unknown as { document: { documentElement: { outerHTML: string }; body: { innerText: string } | null } }).document;
					return w === 'html' ? doc.documentElement.outerHTML : (doc.body?.innerText ?? '');
				}, what);
			} catch {
				// a frame that detached while it was read
				return '';
			}
		}));
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

	public checkButton(): Locator {
		return this.page.getByRole('button', { name: 'Check synchronisation configuration', exact: true });
	}

	// The outcome of the check, from upstream's three status texts (config-shared.ts checkSyncConfig).
	public async configCheckStatus(): Promise<'success' | 'error' | 'checking' | 'none'> {
		if ((await this.page.getByText('Success! Synchronisation configuration appears to be correct.', { exact: true }).count()) > 0) return 'success';
		if ((await this.errorHeading().count()) > 0) return 'error';
		if ((await this.page.getByText('Checking... Please wait.', { exact: true }).count()) > 0) return 'checking';
		return 'none';
	}

	private errorHeading(): Locator {
		return this.page.getByText(/^Error\. Please check that URL, username, password, etc\. are correct/);
	}

	// The whole error block: upstream's line and the reported error.
	public async configCheckError(): Promise<string> {
		return this.page.locator('div').filter({ has: this.errorHeading() }).last().innerText();
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

	public async encryptionStatus(): Promise<string> {
		return this.page.getByText(/^Encryption is: /).innerText();
	}

	// "Decrypted items: <done> / <total>"; undefined while upstream shows "-".
	public async decryptedStats(): Promise<{ done: number; total: number } | undefined> {
		const m = /Decrypted items: (\d+) \/ (\d+)/.exec(await this.page.getByText(/^Decrypted items: /).innerText());
		return m ? { done: Number(m[1]), total: Number(m[2]) } : undefined;
	}

	// Upstream's literal (not translated) prompt for a master password that is not set or not valid.
	public invalidMasterPasswordText(): Locator {
		return this.page.getByText('The master password is not set or is invalid. Please type it below:', { exact: true });
	}

	public masterPasswordLoaded(): Locator {
		return this.page.getByText('Loaded', { exact: true });
	}

	// docs/test-plans/M2-S1.md Finding F1: "(Master password)" in the key's row shows after a wrong password too, so a right
	// password is told from a wrong one by upstream's invalid-password text being absent and the master password "Loaded".
	public async masterPasswordState(): Promise<'accepted' | 'rejected' | 'pending'> {
		if ((await this.invalidMasterPasswordText().count()) > 0) return 'rejected';
		if ((await this.acceptedMarker().isVisible()) && (await this.masterPasswordLoaded().isVisible())) return 'accepted';
		return 'pending';
	}

	// Upstream's own master-password field (accessibilityLabelledBy the prompt text), apart from the master key's field.
	public masterPasswordField(): Locator {
		return this.page.getByRole('textbox', { name: 'The master password is not set or is invalid. Please type it below:' });
	}

	public async saveMasterPassword(password: string): Promise<void> {
		const field = this.masterPasswordField();
		await typeLikeUser(field, password, { secret: true });
		const save = this.page.getByRole('button', { name: 'Save', exact: true });
		await this.page.locator('div').filter({ has: field }).filter({ has: save }).last().getByRole('button', { name: 'Save', exact: true }).click();
	}
}
