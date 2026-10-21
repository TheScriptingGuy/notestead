// Page objects for upstream's Joplin web app (packages/app-mobile `yarn web`, react-native-web DOM) as served by the
// `web` container (ADR-0001, ADR-0007; docs/test-plans/M1-S7.md §Page objects). Modelled on the role-based models of
// upstream's desktop integration tests (packages/app-desktop/integration-tests/models), written for this DOM; no
// upstream code is copied. Locators use roles and accessible names (react-native-web maps accessibilityRole,
// accessibilityLabel and accessibilityLabelledBy to ARIA); the strings are upstream's en_GB UI texts at the pinned ref.
// Every text goes in through typeLikeUser (real key events; secrets only into password fields, C1-R1).
// M2-S2 adds the note, notebook, tag and alarm screens (docs/test-plans/M2-S2.md §Page objects, F3 to F7).
import type { Locator, Page } from '@playwright/test';
import { waitFor } from '../../../support/poll.ts';
import { datetimeLocalValue } from '../dueDate.ts';
import type { LocalParts } from '../dueDate.ts';
import { SecretInVisibleFieldError, clearLikeUser, knownSecretsNow, secretIn, typeLikeUser } from '../typeLikeUser.ts';

// The first start on the Pi takes ~15 s ("Application is ready" in the console) before the first screen is usable.
export const appStartTimeoutMs = 3 * 60_000;

export const decryptionBannerText = 'Press to set the decryption password.';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A dropdown's button (upstream's Dropdown.tsx): named by the current choice, with the "▼" arrow beside it.
const dropdownButton = (page: Page, current: string): Locator => page.getByRole('button', { name: current, exact: true }).filter({ has: page.getByText('▼', { exact: true }) });

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

	// A notebook in the side menu (open it with openSidebar): a button whose accessibility label is the title at depth 0;
	// a nested notebook carries upstream's " (level n)" in its accessible name (side-menu-content.tsx:272).
	public folderInSideMenu(title: string, depth = 0): Locator {
		if (depth === 0) return this.page.getByRole('button', { name: title, exact: true });
		return this.page.getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}\\s+\\(level ${depth}\\)$`) });
	}

	public expandFolder(title: string): Locator {
		return this.page.getByRole('button', { name: `Expand ${title}`, exact: true });
	}

	// The note list's header names the notebook that is open.
	public notesHeading(title: string): Locator {
		return this.page.getByRole('heading', { name: title, exact: true });
	}

	public async openFolder(title: string, depth = 0): Promise<void> {
		await this.openSidebar();
		await this.folderInSideMenu(title, depth).click();
		await this.notesHeading(title).waitFor();
	}

	// The side menu's "New Notebook" opens upstream's notebook screen (the same one that edits a notebook).
	public async createNotebook(title: string): Promise<void> {
		await this.openSidebar();
		await this.page.getByRole('button', { name: 'New Notebook', exact: true }).click();
		const screen = new FolderScreen(this.page);
		await screen.heading().waitFor();
		await typeLikeUser(screen.titleField(), title);
		await screen.save();
		await this.notesHeading(title).waitFor();
	}

	// Right click is upstream's long press (onContextMenu): a menu with "Edit", then the notebook screen (F3: nesting is
	// done from the child's edit screen, where the parent is listed).
	public async editNotebook(title: string, depth = 0): Promise<FolderScreen> {
		await this.openSidebar();
		await this.folderInSideMenu(title, depth).click({ button: 'right' });
		const menu = this.page.getByTestId('menu-content-open');
		await menu.getByRole('heading', { name: `Notebook: ${title}`, exact: true }).waitFor();
		await menu.getByRole('button', { name: 'Edit', exact: true }).click();
		const screen = new FolderScreen(this.page);
		await screen.heading().waitFor();
		return screen;
	}

	public async openTagsScreen(): Promise<TagsScreen> {
		await this.openSidebar();
		await this.page.getByRole('button', { name: 'Tags', exact: true }).click();
		const screen = new TagsScreen(this.page);
		await screen.heading().waitFor();
		return screen;
	}

	public addNewButton(): Locator {
		return this.page.getByRole('button', { name: 'Add new', exact: true });
	}

	// The FAB's menu (NewNoteButton.tsx): a provisional note in the current notebook, opened in the note screen.
	public async newNote(): Promise<NoteScreen> {
		return this.createFromFab('New note');
	}

	public async newTodo(): Promise<NoteScreen> {
		return this.createFromFab('New to-do');
	}

	private async createFromFab(item: 'New note' | 'New to-do'): Promise<NoteScreen> {
		await this.addNewButton().click();
		await this.page.getByRole('button', { name: item, exact: true }).click();
		const screen = new NoteScreen(this.page);
		await screen.waitOpen();
		return screen;
	}

	// A to-do's checkbox in the note list (NoteItem.tsx: "to-do: <title>").
	public todoCheckbox(title: string): Locator {
		return this.page.getByRole('checkbox', { name: `to-do: ${title}`, exact: true });
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

	// The whole error block: upstream's line and, in a sibling element, the reported error ("Invalid email or password
	// (Code 403)"). The block is the parent of the line: a `div` filter with `has` returned the line alone (observed
	// at v3.7.21, docs/test-plans/M2-S1.md §Results).
	public async configCheckError(): Promise<string> {
		return this.errorHeading().locator('xpath=..').innerText();
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

	public masterKeyHeading(prefix6: string): Locator {
		return this.page.getByRole('heading', { name: `Master Key ${prefix6}`, exact: true });
	}

	// The ❌ next to the key's empty password field (accessibilityRole image, label "Invalid password").
	public invalidKeyPasswordMarker(): Locator {
		return this.masterKeySection().getByRole('img', { name: 'Invalid password', exact: true });
	}

	// Upstream fills the statistics in every 3 s; "-" until then.
	public async pollDecryptedStats(timeoutMs = 30_000): Promise<{ done: number; total: number }> {
		return waitFor('the decrypted-items statistics', async () => this.decryptedStats(), { timeoutMs, intervalMs: 500 });
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

// The note screen (upstream Note.tsx): title field, Markdown editor (CodeMirror in an iframe), the header's notebook
// dropdown and the Actions menu (plan §Page objects; docs/test-plans/M2-S2.md F4, F7).
export class NoteScreen {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public titleField(): Locator {
		return this.page.getByPlaceholder('Add title', { exact: true });
	}

	public async waitOpen(): Promise<void> {
		await this.titleField().waitFor({ timeout: 60_000 });
	}

	// replace: select all and Backspace first (clearLikeUser), then type; the text goes in through typeLikeUser.
	public async typeTitle(text: string, opts: { replace?: boolean } = {}): Promise<void> {
		if (opts.replace) await clearLikeUser(this.titleField());
		await typeLikeUser(this.titleField(), text);
	}

	public editToggle(): Locator {
		return this.page.getByRole('button', { name: 'Edit', exact: true });
	}

	// Upstream's Markdown editor is CodeMirror in an iframe (ExtendedWebView on web, MarkdownEditor.tsx): found as the one
	// frame that has a .cm-content.
	public async editor(): Promise<Locator> {
		return waitFor('the Markdown editor (a frame with a .cm-content)', async () => {
			for (const frame of this.page.frames()) {
				try {
					const content = frame.locator('.cm-content');
					if ((await content.count()) === 1) return content;
				} catch {
					// a frame that detached while it was read
				}
			}
			return undefined;
		}, { timeoutMs: 60_000, intervalMs: 250 });
	}

	public async startEditing(): Promise<Locator> {
		if (await this.editToggle().isVisible()) await this.editToggle().click();
		return this.editor();
	}

	// The editor's lines, joined with newlines.
	public async editorText(): Promise<string> {
		const content = await this.editor();
		return content.evaluate(el => {
			const root = el as unknown as { querySelectorAll: (selector: string) => ArrayLike<{ textContent: string | null }> };
			return Array.from(root.querySelectorAll('.cm-line')).map(line => line.textContent ?? '').join('\n');
		});
	}

	// Typed with real key events into the editor (Enter for a newline); never a secret (the trace's frames cannot be
	// redacted, C1-R1). replace: select all and Backspace first, until the editor is empty; otherwise the text goes at the
	// end. Done when the editor's lines equal the old text plus the typed text.
	public async typeBody(text: string, opts: { replace?: boolean } = {}): Promise<void> {
		const known = secretIn(text, knownSecretsNow());
		if (known) throw new SecretInVisibleFieldError(`C1-R1: refusing to type a secret ([${known}]) into the note body: the trace's screencast frames cannot be redacted`);
		const editor = await this.startEditing();
		await editor.click();
		if (opts.replace) {
			await this.page.keyboard.press('ControlOrMeta+a');
			await this.page.keyboard.press('Backspace');
			await waitFor('the editor to be empty', async () => ((await this.editorText()) === '' ? true : undefined), { timeoutMs: 30_000, intervalMs: 100 });
		} else {
			await this.page.keyboard.press('ControlOrMeta+End');
		}
		const before = await this.editorText();
		await editor.pressSequentially(text);
		await waitFor('the editor to hold the typed body', async () => ((await this.editorText()) === before + text ? true : undefined), { timeoutMs: 30_000, intervalMs: 100 });
	}

	// Upstream's own test id for the header menu trigger (ScreenHeader/Menu.tsx; its Note.test.tsx uses it too).
	public actionsButton(): Locator {
		return this.page.getByTestId('screen-header-menu-trigger');
	}

	public async menuAction(title: string): Promise<void> {
		await this.actionsButton().click();
		await this.page.getByTestId('menu-content-open').getByRole('button', { name: title, exact: true }).click();
	}

	// The header's notebook dropdown: a button named by the current notebook, with upstream's "▼".
	public folderPicker(current: string): Locator {
		return dropdownButton(this.page, current);
	}

	public async moveTo(current: string, target: string): Promise<void> {
		await this.folderPicker(current).click();
		await this.page.getByRole('menuitem', { name: target, exact: true }).click();
		await this.folderPicker(target).waitFor();
	}

	public async openTags(): Promise<TagsDialog> {
		await this.menuAction('Tags');
		const dialog = new TagsDialog(this.page);
		await dialog.searchField().waitFor();
		return dialog;
	}

	public async openAlarm(): Promise<AlarmDialog> {
		await this.menuAction('Set alarm');
		const dialog = new AlarmDialog(this.page);
		await dialog.input().waitFor();
		return dialog;
	}

	// To the trash, with no confirmation; the screen stays on the note (F4).
	public async deleteToTrash(): Promise<void> {
		await this.menuAction('Delete');
	}
}

// Upstream's "Set alarm" dialog (SelectDateTimeDialog.tsx, web branch): a native datetime-local input.
export class AlarmDialog {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	// No ARIA role exists for it.
	public input(): Locator {
		return this.page.locator('input[type="datetime-local"]');
	}

	// Typed segment by segment, as a user does in Chromium's en-GB datetime-local (dd/mm/yyyy, hh:mm): the focus starts on
	// the day; day and month advance by themselves; ArrowRight leaves the year. Done when the input holds the full value.
	public async enterLocal(parts: LocalParts): Promise<void> {
		const want = datetimeLocalValue(parts);
		await this.input().pressSequentially(`${parts.day}${parts.month}${parts.year}`);
		await this.page.keyboard.press('ArrowRight');
		await this.page.keyboard.type(`${parts.hour}${parts.minute}`);
		await waitFor(`the date input to hold ${want}`, async () => ((await this.input().inputValue()) === want ? true : undefined), { timeoutMs: 10_000, intervalMs: 100 });
	}

	// "Save alarm", then upstream's web-only alert (Note.tsx:1220): its message is returned and it is accepted. The alert
	// blocks the click until it is handled, so the handler runs beside the click.
	public async save(): Promise<string> {
		const handled = this.page.waitForEvent('dialog', { timeout: 30_000 }).then(async dialog => {
			const message = dialog.message();
			await dialog.accept();
			return message;
		});
		await Promise.all([handled, this.page.getByRole('button', { name: 'Save alarm', exact: true }).click()]);
		return handled;
	}
}

// The note's "Tags" dialog (NoteTagsDialog.tsx, TagEditor.tsx, ComboBox.tsx).
export class TagsDialog {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public searchField(): Locator {
		return this.page.getByPlaceholder('Search tags', { exact: true });
	}

	public removeButton(title: string): Locator {
		return this.page.getByRole('button', { name: `Remove ${title}`, exact: true });
	}

	public async addNew(title: string): Promise<void> {
		await typeLikeUser(this.searchField(), title);
		await this.page.getByRole('option', { name: 'Add new', exact: true }).click();
		await this.removeButton(title).waitFor();
	}

	public async remove(title: string): Promise<void> {
		await this.removeButton(title).click();
		await this.removeButton(title).waitFor({ state: 'detached' });
	}

	public async apply(): Promise<void> {
		await this.page.getByRole('button', { name: 'Apply', exact: true }).click();
		await this.searchField().waitFor({ state: 'detached' });
	}
}

// The side menu's "Tags" screen (screens/tags.tsx): a long press (right click) opens a menu with "Rename".
export class TagsScreen {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public heading(): Locator {
		return this.page.getByRole('heading', { name: 'Tags', exact: true });
	}

	public tagItem(title: string): Locator {
		return this.page.getByRole('button', { name: title, exact: true });
	}

	public async rename(oldTitle: string, newTitle: string): Promise<void> {
		await this.tagItem(oldTitle).click({ button: 'right' });
		await this.page.getByTestId('prompt-dialog').getByRole('button', { name: 'Rename', exact: true }).click();
		const field = this.page.getByTestId('prompt-dialog').getByRole('textbox', { name: 'Rename tag:', exact: true });
		await clearLikeUser(field);
		await typeLikeUser(field, newTitle);
		await this.page.getByTestId('prompt-dialog').getByRole('button', { name: 'OK', exact: true }).click();
		await this.tagItem(newTitle).waitFor();
	}
}

// Upstream's notebook screen (screens/folder.tsx): "Edit notebook" for a new and for an existing notebook (F3).
export class FolderScreen {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public heading(): Locator {
		return this.page.getByRole('heading', { name: 'Edit notebook', exact: true });
	}

	public titleField(): Locator {
		return this.page.getByPlaceholder('Enter notebook title', { exact: true });
	}

	// A top-level notebook shows the placeholder 'Select parent notebook'.
	public parentPicker(current: string): Locator {
		return dropdownButton(this.page, current);
	}

	public async rename(newTitle: string): Promise<void> {
		await clearLikeUser(this.titleField());
		await typeLikeUser(this.titleField(), newTitle);
	}

	public async setParent(current: string, parent: string): Promise<void> {
		await this.parentPicker(current).click();
		await this.page.getByRole('menuitem', { name: parent, exact: true }).click();
		await this.parentPicker(parent).waitFor();
	}

	public async save(): Promise<void> {
		await this.page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await this.heading().waitFor({ state: 'detached' });
	}
}
