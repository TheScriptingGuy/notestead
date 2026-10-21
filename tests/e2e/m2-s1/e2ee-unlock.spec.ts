// M2-S1 / M2-AC2 (docs/backlog/M2.md §M2-S1; docs/test-plans/M2-S1.md): an E2EE account (E2EE turned on by another device,
// which seeded one folder and three notes, one with non-ASCII text). The web app, configured through the proxy, reports that
// the account's data is end-to-end encrypted and asks for the master password (banner, encryption screen with the account's
// master key not unlocked), and no seeded content is readable: planner decision D1 (plan §Planner decisions; upstream
// downloads nothing before the key is loaded, so there are no placeholders to count). After the master password, every seeded title and body is shown decrypted, and a data assertion
// compares them with the seed through the headless REST API (before the web app syncs, and again after an unlock and one
// headless sync, with exactly one note per title).
// NEG: a wrong master password shows upstream's error (the master key's field, then upstream's master-password field with
// its alert); no seeded item becomes readable: none of its text reaches the page or the web app's local profile (D2, OPFS
// scan, with the positive test as its control), and the server's items stay byte-identical.
// Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomBytes } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled, ok, pick } from '../support/dataApi.ts';
import type { DataApi } from '../support/fixtures.ts';
import { expect, test } from '../support/fixtures.ts';
import { configureJoplinServerSync, firstSyncTimeoutMs } from '../support/flows.ts';
import { classifyRequests, violationLines } from '../support/network.ts';
import { scanLocalProfile } from '../support/localProfile.ts';
import { JoplinWebApp } from '../support/pages/joplinWebApp.ts';
import { holdsFor } from '../../support/poll.ts';
import { registerSecrets } from '../../support/secrets.ts';
import { serverItemContent, serverItemNames, syncHeadlessOnce } from '../../stack/stack.ts';
import type { Account, StackState } from '../../stack/stack.ts';

interface Seed {
	folder: string;
	tag: string;
	notes: { id: string; title: string; body: string }[];
}

const seedOf = (account: Account): Seed => {
	const seed = { folder: account.folder ?? '', tag: account.seedTag ?? '', notes: account.notes ?? [] };
	expect(seed.folder, 'the account has a seeded folder').not.toBe('');
	expect(seed.tag, 'the account has a seed tag').not.toBe('');
	expect(seed.notes, 'the account has three seeded notes').toHaveLength(3);
	return seed;
};

// The first seeded value found in `html`, or undefined (absence check over the page and every frame).
const noSeedIn = (html: string, seed: Seed): string | undefined => [seed.tag, seed.folder, ...seed.notes.map(n => n.title), ...seed.notes.map(n => n.body)].find(v => html.includes(v));

const md = (names: string[]): string[] => names.filter(n => /^[0-9a-f]{32}\.md$/.test(n));

interface InfoJson {
	version?: unknown;
	e2ee?: { value?: unknown };
	activeMasterKeyId?: { value?: unknown };
	masterKeys?: { id?: unknown }[];
}

const infoJson = async (stack: StackState, account: Account): Promise<InfoJson> => {
	const info = await serverItemContent(stack, account, 'info.json');
	expect(info.status, 'GET info.json from the server').toBe(200);
	return JSON.parse(info.text) as InfoJson;
};

// The server's copies of the account's items (<32 hex>.md): all end-to-end encrypted, none holding the seed tag (D1 data level).
const serverSeedEncrypted = async (stack: StackState, account: Account, seed: Seed): Promise<Record<string, string>> => {
	const items: Record<string, string> = {};
	for (const name of md(await serverItemNames(stack, account))) {
		const content = await serverItemContent(stack, account, name);
		expect(content.status, `GET ${name}`).toBe(200);
		items[name] = content.text;
	}
	expect(Object.keys(items).length, 'the seeded notes and the folder are on the server').toBeGreaterThanOrEqual(4);
	for (const [name, text] of Object.entries(items)) {
		expect(text, `${name} is encrypted`).toMatch(/^encryption_applied: 1$/m);
		expect(text.includes(seed.tag), `${name} holds no clear seed text`).toBe(false);
	}
	return items;
};

// The id of the account's active master key, from info.json (the key the encryption screen lists).
const activeKeyOf = (info: InfoJson): string => {
	const id = info.activeMasterKeyId?.value;
	expect(typeof id, 'info.json activeMasterKeyId.value is a string').toBe('string');
	expect(id, 'info.json activeMasterKeyId.value is a 32-hex id').toMatch(/^[0-9a-f]{32}$/);
	expect((info.masterKeys ?? []).map(k => k.id), 'info.json holds exactly the active master key').toEqual([id]);
	return id as string;
};

const noteFields = 'id,title,body,parent_id,encryption_applied,is_conflict';

// The reference: each seeded note as the headless REST API has it (decrypted), checked against the seed.
const readReference = (dataApi: DataApi, seed: Seed): Record<string, unknown>[] => seed.notes.map(n => {
	const note = pick(ok(dataApi.get(`/notes/${n.id}?fields=${noteFields}`), `GET /notes/${n.id}`), noteFields.split(','));
	expect(note, `note "${n.title}" through the headless REST API`).toMatchObject({ id: n.id, title: n.title, body: n.body, encryption_applied: 0, is_conflict: 0 });
	return note;
});

test.describe('M2-S1 E2EE unlock in the web app', () => {
	test.use({ e2eeSeed: { notes: 3 } });

	test('M2-AC2 the web app reports the account as end-to-end encrypted and asks for the master password, and after the master password shows every seeded title and body as the headless REST API has them', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S1');
		const seed = seedOf(e2eeAccount);
		const app = new JoplinWebApp(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		let reference: Record<string, unknown>[] = [];
		let activeKey = '';

		await test.step('0. data level before: info.json is version 3 with E2EE on (written by the CLI device)', async () => {
			const info = await infoJson(stack, e2eeAccount);
			expect(info.version).toBe(3);
			expect(info.e2ee?.value).toBe(true);
			activeKey = activeKeyOf(info);
		});

		await test.step('1. configure the web app', async () => {
			await configureJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			await expect(app.decryptionBanner(), 'the web app synced and asks for the master password').toBeVisible({ timeout: firstSyncTimeoutMs });
		});

		await test.step('2. data level: the headless REST API has the seed decrypted', async () => {
			reference = readReference(dataApi, seed);
			expect(new Set(reference.map(n => n.parent_id)).size, 'the three notes share one folder').toBe(1);
			const folder = pick(ok(dataApi.get(`/folders/${String(reference[0].parent_id)}?fields=id,title`), 'GET /folders/:id'), ['title']);
			expect(folder).toEqual({ title: seed.folder });
		});

		let totalBefore = 0;
		const screen = await test.step('3. the app reports that the data is encrypted and asks for the master password', async () => {
			expect(noSeedIn(await app.frameHtml(), seed), 'no seeded value in the page or any frame while encrypted').toBeUndefined();
			const encryption = await app.openEncryptionSettingsFromBanner();
			expect(await encryption.encryptionStatus()).toBe('Encryption is: Enabled');
			await expect(encryption.masterKeyHeading(activeKey.slice(0, 6))).toBeVisible();
			await expect(encryption.invalidKeyPasswordMarker()).toBeVisible();
			expect(await encryption.masterPasswordState()).toBe('pending');
			totalBefore = (await encryption.pollDecryptedStats()).total;
			await serverSeedEncrypted(stack, e2eeAccount, seed);
			return encryption;
		});

		await test.step('4. enter the master password', async () => {
			await screen.enterMasterPassword(e2eeAccount.masterPassword);
			await expect.poll(() => screen.masterPasswordState(), { timeout: 60_000, intervals: [500] }).toBe('accepted');
			await expect.poll(async () => {
				const s = await screen.decryptedStats();
				if (!s) return 'no stats yet';
				return s.done === s.total && s.total >= totalBefore + 4 ? 'all' : `${s.done} / ${s.total} (before: ${totalBefore})`;
			}, { timeout: 3 * 60_000, intervals: [1_000] }).toBe('all');
			await screen.back();
		});

		await test.step('5. every seeded title is in the note list and the folder in the side menu', async () => {
			for (const n of seed.notes) {
				await expect.poll(() => app.noteInList(n.title).isVisible(), { timeout: 3 * 60_000, intervals: [1_000] }).toBe(true);
			}
			await expect.poll(() => app.encryptedNotesInList().count(), { timeout: 60_000, intervals: [1_000] }).toBe(0);
			await app.openSidebar();
			await expect(app.folderInSideMenu(seed.folder)).toBeVisible();
			await app.closeSidebar();
		});

		await test.step('6. every seeded body is shown decrypted', async () => {
			for (const n of reference) {
				await app.openNote(String(n.title));
				await expect.poll(() => app.frameText(), { timeout: 60_000, intervals: [500] }).toContain(String(n.body));
				await app.backToList();
			}
		});

		await test.step('7. the local profile holds the decrypted seed (positive control of the NEG\'s scan)', async () => {
			const scan = await scanLocalProfile(webApp, seed.tag);
			expect(scan.files).toBeGreaterThan(0);
			expect(scan.hits.length, `seed tag in the local profile (${scan.files} files, ${scan.bytes} bytes)`).toBeGreaterThan(0);
		});

		await test.step('8. network policy', async () => {
			const verdict = classifyRequests(webNetwork.entries(), origin);
			expect(violationLines(verdict)).toEqual([]);
			expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
			expect(verdict.syncTraffic.length).toBeGreaterThan(0);
		});

		await test.step('9. data level after: one headless sync, the same values, no conflict copy, info.json unchanged', async () => {
			await syncHeadlessOnce(stack, headlessService);
			expect(readReference(dataApi, seed)).toEqual(reference);
			for (const n of seed.notes) expect(notesTitled(dataApi, n.title).map(x => x.id), `exactly one note titled "${n.title}"`).toEqual([n.id]);
			const info = await infoJson(stack, e2eeAccount);
			expect(info.version).toBe(3);
			expect(info.e2ee?.value).toBe(true);
		});
	});

	test('M2-AC2 NEG a wrong master password keeps every seeded item unreadable and shows upstream\'s error; nothing is decrypted', async ({ stack, joplinServer, e2eeAccount, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S1');
		const seed = seedOf(e2eeAccount);
		const app = new JoplinWebApp(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const hex = (): string => randomBytes(12).toString('hex');

		let activeKey = '';
		let before: Record<string, string> = {};
		await test.step('1. the server\'s items before the web app is configured: all encrypted, no seed text', async () => {
			before = await serverSeedEncrypted(stack, e2eeAccount, seed);
			activeKey = activeKeyOf(await infoJson(stack, e2eeAccount));
		});

		const screen = await test.step('2. configure the web app: it reports that the data is encrypted', async () => {
			await configureJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			await expect(app.decryptionBanner(), 'the web app synced and asks for the master password').toBeVisible({ timeout: firstSyncTimeoutMs });
			expect(noSeedIn(await app.frameHtml(), seed), 'no seeded value in the page or any frame while encrypted').toBeUndefined();
			const encryption = await app.openEncryptionSettingsFromBanner();
			expect(await encryption.encryptionStatus()).toBe('Encryption is: Enabled');
			await expect(encryption.masterKeyHeading(activeKey.slice(0, 6))).toBeVisible();
			await expect(encryption.invalidKeyPasswordMarker()).toBeVisible();
			expect(await encryption.masterPasswordState()).toBe('pending');
			return encryption;
		});

		await test.step('3. stage 1: a wrong password in the master key\'s field is rejected with upstream\'s text', async () => {
			const wrong1 = `nstwrong${hex()}`;
			registerSecrets([{ label: 'm2_ac2_wrong_master_password_1', value: wrong1 }]);
			await screen.enterMasterPassword(wrong1);
			await expect.poll(() => screen.masterPasswordState(), { timeout: 60_000, intervals: [500] }).toBe('rejected');
			await expect(screen.invalidMasterPasswordText()).toBeVisible();
		});

		await test.step('4. stage 2: a wrong password in upstream\'s master-password field shows its alert', async () => {
			const wrong2 = `nstwrong${hex()}`;
			registerSecrets([{ label: 'm2_ac2_wrong_master_password_2', value: wrong2 }]);
			const dialog = webApp.page.waitForEvent('dialog', { timeout: 60_000 }).then(async d => {
				const message = d.message();
				await d.dismiss();
				return message;
			});
			await Promise.all([dialog, screen.saveMasterPassword(wrong2)]);
			expect(await dialog).toBe('Password is invalid. Please try again.');
		});

		await test.step('5. for 60 s every seeded item stays encrypted', async () => {
			await screen.back();
			await holdsFor('every seeded item stays encrypted', async () => {
				const leaked = noSeedIn(await app.frameHtml(), seed);
				if (leaked !== undefined) return 'a seeded value is in the page or a frame (decrypted)';
				if (!(await app.decryptionBanner().isVisible())) return 'the decryption banner is gone';
				return undefined;
			}, { windowMs: 60_000, intervalMs: 1_000 });
		});

		await test.step('6. the encryption screen still reports the items as not decrypted and the password as rejected', async () => {
			const encryption = await app.openEncryptionSettingsFromBanner();
			expect(await encryption.masterPasswordState()).toBe('rejected');
		});

		await test.step('7. nothing decrypted in the local profile', async () => {
			const scan = await scanLocalProfile(webApp, seed.tag);
			expect(scan.files).toBeGreaterThan(0);
			expect(scan.hits).toEqual([]);
		});

		await test.step('8. data level: the server\'s items are byte-identical and none was added or removed', async () => {
			const after = md(await serverItemNames(stack, e2eeAccount));
			expect(after).toEqual(Object.keys(before).sort());
			for (const name of after) expect((await serverItemContent(stack, e2eeAccount, name)).text, `${name} unchanged`).toBe(before[name]);
			expect(violationLines(classifyRequests(webNetwork.entries(), origin))).toEqual([]);
		});
	});
});
