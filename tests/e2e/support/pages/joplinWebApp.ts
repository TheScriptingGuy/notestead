// Page objects for upstream's Joplin web app (packages/app-mobile `yarn web`, react-native-web DOM) as served by the
// `web` container (ADR-0001, ADR-0007; docs/test-plans/M1-S7.md §Page objects). Modelled on the role-based models of
// upstream's desktop integration tests (packages/app-desktop/integration-tests/models), written for this DOM; no
// upstream code is copied. Locators use roles and accessible names (react-native-web maps accessibilityRole,
// accessibilityLabel and accessibilityLabelledBy to ARIA); the strings are upstream's en_GB UI texts at the pinned ref.
// Every text goes in through typeLikeUser (real key events; secrets only into password fields, C1-R1).
// M2-S2 adds the note, notebook, tag and alarm screens (docs/test-plans/M2-S2.md §Page objects, F3 to F7).
import { expect, test } from '@playwright/test';
import type { Frame, Locator, Page } from '@playwright/test';
import { waitFor } from '../../../support/poll.ts';
import { datetimeLocalValue } from '../dueDate.ts';
import type { LocalParts } from '../dueDate.ts';
import { SecretInVisibleFieldError, clearLikeUser, knownSecretsNow, secretIn, typeLikeUser } from '../typeLikeUser.ts';
import { focusTargetFor, settleTracker } from '../settle.ts';
import { afterStayed, trashExit } from '../trashExit.ts';

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

	// The note list's header search button (ScreenHeader/index.tsx searchButton: an IconButton described "Search").
	public searchButton(): Locator {
		return this.page.getByRole('button', { name: 'Search', exact: true });
	}

	public async openSearch(): Promise<SearchScreen> {
		await this.searchButton().click();
		const search = new SearchScreen(this.page);
		await search.waitOpen();
		return search;
	}

	// The side menu's "Trash" notebook, which upstream always lists (folders-screen-utils.ts includeTrash).
	public async openTrash(): Promise<void> {
		await this.openFolder('Trash');
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

	// Configuration from the side menu (side-menu-content.tsx: the button is named by _('Configuration')). The side menu closes
	// on its own when the screen opens.
	public async openConfiguration(): Promise<ConfigScreen> {
		await this.openSidebar();
		await this.page.getByRole('button', { name: 'Configuration', exact: true }).click();
		const screen = new ConfigScreen(this.page);
		await screen.waitOpen();
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
		const timing = await screen.waitSettled(item === 'New to-do' ? 'todo' : 'note');
		test.info().annotations.push({ type: 'settle', description: `${timing.kind}: editor ${timing.editorMs} ms, focus on the ${focusTargetFor(timing.kind)} at ${timing.landedMs} ms, settled ${timing.settledMs} ms` });
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

	// Deletes the open note to the trash and ends on the note list. Upstream either stays on the note screen or leaves it by
	// itself (CI-M2-S2 E); both are accepted, within 30 s, and which one happened is returned.
	public async trashOpenNote(note: NoteScreen): Promise<'left' | 'stayed'> {
		const deletedAt = Date.now();
		await note.menuAction('Delete');
		const outcome = await waitFor('the note screen to leave by itself, or to settle on the trashed note', async () => trashExit({
			onList: (await this.sidebarButton().isVisible()) && (await note.titleField().count()) === 0,
			onNote: await note.titleField().isVisible(),
			backVisible: await this.page.getByRole('button', { name: 'Back', exact: true }).isVisible(),
			msSinceDelete: Date.now() - deletedAt,
		}), { timeoutMs: 30_000, intervalMs: 100 });
		if (outcome === 'stayed') {
			// Back, with its own bound: upstream may still leave by itself after the press began (CI-M2-S2 r2 C1, afterStayed).
			let click: 'done' | 'detached' | 'timeout' = 'done';
			try {
				await this.page.getByRole('button', { name: 'Back', exact: true }).click({ timeout: 10_000 });
			} catch (error) {
				click = (error as Error).name === 'TimeoutError' ? 'timeout' : 'detached';
			}
			if (click !== 'done') {
				const observe = async () => afterStayed(click, {
					onList: (await this.sidebarButton().isVisible()) && (await note.titleField().count()) === 0,
					onNote: await note.titleField().isVisible(),
					backVisible: await this.page.getByRole('button', { name: 'Back', exact: true }).isVisible(),
					msSinceDelete: Date.now() - deletedAt,
				});
				if ((await observe()) === 'fail') throw new Error('the trashed note stayed and its Back button could not be pressed within 10 s');
				let failed: string | undefined;
				await waitFor('the trashed note to be left after the Back press began', async () => {
					const verdict = await observe();
					if (verdict === 'fail') failed = 'the trashed note stayed and its Back button could not be pressed within 10 s';
					return verdict === 'left' ? true : undefined;
				}, { timeoutMs: 10_000, intervalMs: 100, failFast: () => failed });
			}
		}
		await this.sidebarButton().waitFor();
		return outcome;
	}

	// The HTML of the page and of every frame, for absence checks (it holds attributes such as aria-label and hidden text).
	// The note viewer is a sandboxed srcdoc iframe (ExtendedWebView/index.web.tsx), so the page's own DOM never holds a body.
	public async frameHtml(): Promise<string> {
		return (await this.perFrame('html')).join('\n');
	}

	// What the app renders in the TOP frame only (docs/test-plans/M2-S4.md, H5 ruling): `innerText` of the body (no script or style
	// content, no hidden elements, no child frames) and the body's accessibility tree (adds aria-label names). A plugin's
	// background frames hold only scripts, so a rendered plugin view would be in the top frame.
	public async renderedTopFrame(): Promise<{ text: string; aria: string }> {
		const body = this.page.locator('body');
		return { text: await body.innerText(), aria: await body.ariaSnapshot() };
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
// dropdown and the Actions menu (plan §Page objects; docs/test-plans/M2-S2.md F4 (upstream may stay on a trashed note or leave it, CI-M2-S2 E), F7).
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

	// A new note opens in edit mode, and upstream then moves the focus: to a to-do's title, to a note's body, which is the
	// Markdown editor, by a command queued to the editor's frame, so it lands when that frame has loaded (Note.tsx
	// scheduleFocusUpdate; docs/test-plans/M2-S3.md D8 C1, F5). In the first full M2-S2 run the first characters of a title
	// went into the title field and the rest into the body. So a test waits for the editor frame (the positive event), then for
	// the focus to land on upstream's target and stay there for 10 polls (a stabilisation anchored to an observed event, not a
	// sleep), before it types. The lag is returned and recorded as the `settle` annotation.
	public async waitSettled(kind: 'note' | 'todo'): Promise<{ kind: 'note' | 'todo'; editorMs: number; landedMs: number; settledMs: number }> {
		const started = Date.now();
		await this.editorFrame();
		const editorMs = Date.now() - started;
		const target = focusTargetFor(kind);
		const settled = settleTracker(target, 10);
		let landedMs: number | undefined;
		const settledMs = await waitFor(`the focus to land on the ${target} (upstream's focus for a new ${kind}) and stay for 10 polls`, async () => {
			const owner = await this.focusOwner();
			if (owner === target) landedMs ??= Date.now() - started;
			else landedMs = undefined;
			return settled(owner) ? Date.now() - started : undefined;
		}, { timeoutMs: 60_000, intervalMs: 100 });
		return { kind, editorMs, landedMs: landedMs ?? settledMs, settledMs };
	}

	// Who holds the focus: 'title' (the title field), 'editor' (inside the Markdown editor's .cm-content), or 'other:<tag>'
	// (another element of the page, or of the editor's frame).
	private async focusOwner(): Promise<string> {
		const frame = await this.editorFrame();
		const iframe = await frame.frameElement();
		const title = await this.titleField().elementHandle();
		try {
			const top = await this.page.evaluate(([t, f]) => {
				const active = (globalThis as unknown as { document: { activeElement: { localName?: string } | null } }).document.activeElement;
				if ((active as unknown) === t) return 'title';
				if ((active as unknown) === f) return 'iframe';
				return `other:${String(active?.localName ?? 'none')}`;
			}, [title, iframe] as const);
			if (top !== 'iframe') return top;
			return await frame.evaluate(() => {
				const active = (globalThis as unknown as { document: { activeElement: { closest?: (s: string) => unknown } | null } }).document.activeElement;
				return active?.closest?.('.cm-content') ? 'editor' : 'other:iframe';
			});
		} finally {
			await title?.dispose();
			await iframe.dispose();
		}
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
	public async editorFrame(): Promise<Frame> {
		return waitFor('the Markdown editor (a frame with a .cm-content)', async () => {
			for (const frame of this.page.frames()) {
				try {
					if ((await frame.locator('.cm-content').count()) === 1) return frame;
				} catch {
					// a frame that detached while it was read
				}
			}
			return undefined;
		}, { timeoutMs: 60_000, intervalMs: 250 });
	}

	public async editor(): Promise<Locator> {
		return (await this.editorFrame()).locator('.cm-content');
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

	// The accessible names of every item of the note's action menu (docs/test-plans/M2-S4.md NEG1, `pluginRunning`): opens the
	// menu, reads its buttons, closes it with Escape. Plugin commands for the note toolbar are items of this menu (Note.tsx).
	public async menuItemNames(): Promise<string[]> {
		await this.actionsButton().click();
		const menu = this.page.getByTestId('menu-content-open');
		await menu.waitFor();
		// A button's name is its aria-label, else the text of its descendants that are not aria-hidden (an item's icon is a hidden
		// glyph in front of its label, and an item without an aria-label, such as a plugin's command, has only that text).
		const names = await menu.getByRole('button').evaluateAll(buttons => buttons.map(b => {
			interface El { getAttribute: (n: string) => string | null; childNodes: ArrayLike<El & { nodeType: number; textContent: string | null }> }
			const label = (b as unknown as El).getAttribute('aria-label');
			if (label !== null && label !== '') return label.trim();
			const text = (node: El & { nodeType: number; textContent: string | null }): string => {
				if (node.nodeType === 3) return node.textContent ?? '';
				if (node.nodeType !== 1 || node.getAttribute('aria-hidden') === 'true') return '';
				return Array.from(node.childNodes, text).join(' ');
			};
			return text(b as unknown as El & { nodeType: number; textContent: string | null }).replace(/\s+/g, ' ').trim();
		}));
		await this.page.keyboard.press('Escape');
		await menu.waitFor({ state: 'hidden' });
		return names;
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

	// Upstream's Attach... (Note.tsx menuOptions) → "Choose an option" (DialogManager showMenu, test id prompt-dialog) → "Attach file"
	// → pickDocument creates a hidden <input type="file" multiple> and clicks it, so Playwright sees a file chooser. The file goes
	// in by path (a local browser reads it itself: no buffer limit), never as a buffer.
	public async attachFile(path: string, timeoutMs: number): Promise<void> {
		await this.menuAction('Attach...');
		const chooserEvent = this.page.waitForEvent('filechooser', { timeout: 30_000 });
		await this.page.getByTestId('prompt-dialog').getByRole('button', { name: 'Attach file', exact: true }).click();
		const chooser = await chooserEvent;
		if (!chooser.isMultiple()) throw new Error('the file chooser is not upstream\'s attach input (pickDocument: multiple)');
		await chooser.setFiles(path, { timeout: timeoutMs });
	}

	// The link upstream inserts into the Markdown editor for an attachment (Resource.markupTag): ![name](:/<id>) or [name](:/<id>).
	// Returns the resource id.
	public async waitForAttachmentLink(fileName: string, timeoutMs: number): Promise<string> {
		const link = new RegExp(`\\[${escapeRegExp(fileName)}\\]\\(:/([0-9a-f]{32})\\)`);
		return waitFor(`the editor to hold the link to ${fileName}`, async () => link.exec(await this.editorText())?.[1], { timeoutMs, intervalMs: 500 });
	}

	// A trashed note's Actions offer "Restore" (Note.tsx: restoreItems, then back to the list).
	public async restore(): Promise<void> {
		await this.menuAction('Restore');
	}

	// The note viewer (a sandboxed srcdoc iframe) shows an image attachment as <img data-resource-id> with a blob: URL it made from
	// the File the app passed it, or upstream's placeholder .not-loaded-resource[data-resource-id] (docs/test-plans/M2-S3.md D5, F4).
	public async viewerImage(resourceId: string): Promise<{ found: boolean; complete?: boolean; naturalWidth?: number; naturalHeight?: number; scheme?: string; placeholder: boolean }> {
		if (!/^[0-9a-f]{32}$/.test(resourceId)) throw new Error('viewerImage: a resource id is 32 hex characters');
		type Reading = { found: boolean; complete?: boolean; naturalWidth?: number; naturalHeight?: number; scheme?: string; placeholder: boolean };
		const readings = await Promise.all(this.page.frames().map(async (frame): Promise<Reading> => {
			try {
				return await frame.evaluate((id): Reading => {
					interface Img { complete: boolean; naturalWidth: number; naturalHeight: number; src: string }
					const doc = (globalThis as unknown as { document: { querySelector: (s: string) => unknown } }).document;
					const img = doc.querySelector(`img[data-resource-id="${id}"]`) as Img | null;
					const placeholder = !!doc.querySelector(`.not-loaded-resource[data-resource-id="${id}"]`);
					if (!img) return { found: false, placeholder };
					return { found: true, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, scheme: new URL(img.src).protocol, placeholder };
				}, resourceId);
			} catch {
				return { found: false, placeholder: false };
			}
		}));
		return readings.find(r => r.found) ?? readings.find(r => r.placeholder) ?? { found: false, placeholder: false };
	}

	// The bytes the viewer shows: fetched inside that frame from its own blob: URL (the page's CSP allows connect-src blob:).
	public async viewerImageBytes(resourceId: string): Promise<Buffer> {
		if (!/^[0-9a-f]{32}$/.test(resourceId)) throw new Error('viewerImageBytes: a resource id is 32 hex characters');
		for (const frame of this.page.frames()) {
			let read: { b64?: string; error?: string } | undefined;
			try {
				read = await frame.evaluate(async id => {
					const g = globalThis as unknown as { document: { querySelector: (s: string) => { src: string } | null }; fetch: (u: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>; btoa: (s: string) => string };
					const img = g.document.querySelector(`img[data-resource-id="${id}"]`);
					if (!img) return undefined;
					try {
						const bytes = new Uint8Array(await (await g.fetch(img.src)).arrayBuffer());
						let binary = '';
						for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
						return { b64: g.btoa(binary) };
					} catch (e) {
						return { error: `${(e as Error).name}: ${(e as Error).message}` };
					}
				}, resourceId);
			} catch {
				read = undefined; // a detached frame
			}
			if (!read) continue;
			if (read.error) throw new Error(`the viewer frame could not read its image: ${read.error}`);
			return Buffer.from(read.b64 ?? '', 'base64');
		}
		throw new Error(`no frame shows the image of resource ${resourceId}`);
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

// Upstream's Search screen (SearchScreen/index.tsx, SearchResults.tsx, NoteItem.tsx; docs/test-plans/M2-S3.md D3).
export class SearchScreen {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public heading(): Locator {
		return this.page.getByRole('heading', { name: 'Search', exact: true });
	}

	public field(): Locator {
		return this.page.getByPlaceholder('Search notes, notebooks...', { exact: true });
	}

	// The search screen itself: the deepest element holding its header and its field (hidden screens are aria-hidden anyway).
	public root(): Locator {
		return this.page.locator('div').filter({ has: this.heading() }).filter({ has: this.field() }).last();
	}

	public result(title: string): Locator {
		return this.root().getByRole('button', { name: title, exact: true });
	}

	public async waitOpen(): Promise<void> {
		await this.field().waitFor();
	}

	// Upstream runs a query only when its text changes, and indexes a synced note about 10 s after it changes
	// (docs/test-plans/M2-S3.md D3): clear and retype the word, as a user would, until the result shows.
	public async searchUntilFound(word: string, title: string, opts: { timeoutMs?: number; attemptMs?: number } = {}): Promise<{ attempts: number; ms: number }> {
		const started = Date.now();
		let attempts = 0;
		await waitFor(`the search to list the note titled "${title}"`, async () => {
			attempts++;
			await clearLikeUser(this.field());
			await typeLikeUser(this.field(), word);
			try {
				await this.result(title).waitFor({ timeout: opts.attemptMs ?? 5_000 });
				return true;
			} catch {
				return undefined;
			}
		}, { timeoutMs: opts.timeoutMs ?? 180_000, intervalMs: 250 });
		return { attempts, ms: Date.now() - started };
	}

	// From a note opened from the results, "Back" returns here (the search screen has no Sidebar button).
	public async backFromNote(): Promise<void> {
		await this.page.getByRole('button', { name: 'Back', exact: true }).click();
		await this.field().waitFor();
	}

	public async close(): Promise<void> {
		await this.page.getByRole('button', { name: 'Back', exact: true }).click();
		await this.page.getByRole('button', { name: 'Sidebar', exact: true }).waitFor();
	}
}

// Configuration (upstream ConfigScreen.tsx): a section selector (tabs, SectionSelector/SectionTab.tsx) and the open section.
export class ConfigScreen {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	// The screen's header carries the open section's name as its heading ("General" first), not "Configuration", so the screen is
	// told by its "Save changes" button.
	public async waitOpen(): Promise<void> {
		await this.page.getByRole('button', { name: 'Save changes', exact: true }).waitFor();
	}

	// A section's tab, named by Setting.sectionNameToLabel (plus its short description, so the name is matched by its start).
	public async openSection(name: 'Plugins'): Promise<PluginsScreen> {
		await this.page.getByRole('tab', { name: new RegExp(`^${escapeRegExp(name)}`) }).first().click();
		return new PluginsScreen(this.page);
	}

	public async back(): Promise<void> {
		await this.page.getByRole('button', { name: 'Back', exact: true }).click();
	}
}

const pluginChipLabels = ['Incompatible', 'Error', 'Disabled', 'Update available', 'Installed', 'Built-in', 'Dev'] as const;

// Configuration, section Plugins (upstream ConfigScreen/plugins/*): "Enable plugin support" while the setting is off, then the
// list of installed plugins, the repository search and, under "Advanced settings", "Install from file".
export class PluginsScreen {
	public readonly page: Page;

	public constructor(page: Page) {
		this.page = page;
	}

	public enableButton(): Locator {
		return this.page.getByRole('button', { name: 'Enable plugin support', exact: true });
	}

	public noneInstalled(): Locator {
		return this.page.getByText('No plugins are installed.', { exact: true });
	}

	public installedHeading(n: number): Locator {
		return this.page.getByText(`Installed (${n}):`, { exact: true });
	}

	// PluginBox's own test id. While a plugin's info dialog is open it holds a card of its own with the same test id, so a
	// caller that needs the list's card closes the dialog first.
	public card(name: string): Locator {
		return this.page.getByTestId('plugin-card').filter({ hasText: name });
	}

	// The chips of a card, by their visible text (PluginChips.tsx), in the order of `pluginChipLabels`.
	public async chips(name: string): Promise<string[]> {
		const card = this.card(name).first();
		await card.waitFor();
		const shown: string[] = [];
		for (const label of pluginChipLabels) if (await card.getByText(label, { exact: true }).count() > 0) shown.push(label);
		return shown;
	}

	// The card's info dialog (PluginInfoModal.tsx, a DismissibleDialog): its "Enabled" switch and its "Close" button.
	public async openInfo(name: string): Promise<void> {
		await this.card(name).first().click();
		await this.enabledSwitch().waitFor();
	}

	// The dialog's own switch: react-native-web puts the "Enabled" label on a wrapper (accessibilityLabelledBy), so the switch has
	// no accessible name of its own, and the dialog is told by that label. The page behind holds a switch of its own.
	public infoDialog(): Locator {
		return this.page.getByRole('dialog').filter({ has: this.page.getByText('Enabled', { exact: true }) });
	}

	public enabledSwitch(): Locator {
		return this.infoDialog().getByRole('switch');
	}

	public async closeInfo(): Promise<void> {
		await this.page.getByRole('button', { name: 'Close', exact: true }).click();
		await this.enabledSwitch().waitFor({ state: 'hidden' });
	}

	// Presses the card's "Incompatible" chip: upstream shows `describeIncompatibility` in its message box (shim.showMessageBox,
	// DialogManager/PromptDialog.tsx, test id prompt-dialog), then closes it with "OK".
	public async incompatibleMessage(name: string): Promise<string> {
		await this.card(name).first().getByText('Incompatible', { exact: true }).click();
		const dialog = this.page.getByTestId('prompt-dialog');
		await dialog.waitFor();
		const message = (await dialog.innerText()).replace(/\s*\bOK\b\s*$/, '').trim();
		await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		await dialog.waitFor({ state: 'hidden' });
		return message;
	}

	public advancedSettings(): Locator {
		return this.page.getByRole('button', { name: 'Advanced settings', exact: true });
	}

	public installFromFileButton(): Locator {
		return this.page.getByRole('button', { name: 'Install from file', exact: true });
	}

	// The repository has loaded (PluginStates.renderRepoApiStatus): no progress bar, no failure text, no "Content provided by".
	public async repositoryLoaded(timeoutMs: number): Promise<void> {
		await this.page.getByRole('progressbar', { name: 'Loading...' }).waitFor({ state: 'hidden', timeout: timeoutMs });
		await expect(this.page.getByText('Plugin repository failed to load')).toHaveCount(0);
		await expect(this.page.getByText(/^Content provided by:/)).toHaveCount(0);
	}

	public searchField(): Locator {
		return this.page.getByPlaceholder('Search for plugins...', { exact: true });
	}

	public async search(text: string): Promise<void> {
		await typeLikeUser(this.searchField(), text);
	}

	public async clearSearch(): Promise<void> {
		await this.page.getByRole('button', { name: 'Clear search', exact: true }).click();
	}

	// The result card's button (ActionButton.tsx: accessibilityLabel `${title}  ${name}`, two spaces): Install, then Installed.
	public async installFromSearch(name: string, timeoutMs: number): Promise<void> {
		const card = this.card(name).first();
		await card.getByRole('button', { name: new RegExp(`^Install\\s+${escapeRegExp(name)}$`) }).click();
		await expect(card.getByRole('button', { name: new RegExp(`^Installed\\s+${escapeRegExp(name)}$`) })).toBeVisible({ timeout: timeoutMs });
	}
}
