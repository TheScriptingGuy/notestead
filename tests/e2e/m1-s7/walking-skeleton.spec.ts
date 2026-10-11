// M1-S7 walking skeleton (docs/backlog/M1.md §M1-S7, M1-AC21; docs/test-plans/M1-S7.md). ADR-0001 (the upstream web
// bundle), ADR-0002 (the same-origin proxy), ADR-0003 (the headless Data API), ADR-0007 (harness rules).
//   1. a note "Walking skeleton <uuid>" is created through the headless REST Data API;
//   2. one headless sync;
//   3. the web app, in a fresh BrowserContext, is configured to sync with http://127.0.0.1:<port>/joplin-server as a
//      fresh test user (the `e2eeAccount` fixture: E2EE on, turned on by another device);
//   4. the E2EE master password is entered;
//   5. the note title is visible in the note list (expect.poll, no sleeps);
//   6. the note's body read back through the headless REST API equals the created body.
// NEG: the same steps through a web container whose proxy does not rewrite Host: the web app reports a sync error and
// the note never appears within the window.
// Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures.ts';
import type { DataApi, DataApiResult } from '../support/fixtures.ts';
import { configureJoplinServerSync, firstSyncTimeoutMs, unlockE2ee } from '../support/flows.ts';
import { JoplinWebApp, decryptionBannerText } from '../support/pages/joplinWebApp.ts';
import { holdsFor } from '../../support/poll.ts';
import { containerLog, serverItemContent, serverItemNames, syncHeadlessOnce, webRequest } from '../../stack/stack.ts';
import type { Account, HeadlessService, StackState } from '../../stack/stack.ts';
import { request } from '../../contract/support/http.ts';

interface SkeletonNote {
	id: string;
	title: string;
	body: string;
}

// The NEG's absence window, anchored to the first sync error the web app shows. The positive path shows the
// decryption banner ~2 s after its first sync and the title ~16 s after the master password (Pi, arm64); 60 s is more
// than 4x either (docs/testing/strategy.md §3 "Absence over a window"; docs/test-plans/M1-S7.md §NEG window).
const negWindowMs = 60_000;

// The web image must serve upstream's app, not the M1-S4 fixture F3 (whose app.bundle.js is a 64 KiB synthetic file).
const requireUpstreamBundle = async (stack: StackState): Promise<void> => {
	const res = await webRequest(stack, '/app.bundle.js');
	const synthetic = res.text.includes('Notestead M1-S4 synthetic fixture');
	if (res.status !== 200 || synthetic || res.text.length < 1024 * 1024) {
		throw new Error(`M1-S7 needs the upstream web bundle in the web image, but GET /app.bundle.js returned ${res.status}, ${res.text.length} bytes${synthetic ? ', the M1-S4 synthetic fixture F3' : ''}. `
			+ 'Run with NOTESTEAD_WEB_ARTIFACT=<a CI web-bundle artifact dir> (docs/test-plans/M1-S7.md §How to run).');
	}
};

const ok = (r: DataApiResult, what: string): Record<string, unknown> => {
	expect(r.error, `${what}: the Data API probe failed`).toBeUndefined();
	expect(r.status, `${what}: HTTP status`).toBe(200);
	return r.body as Record<string, unknown>;
};

// The named fields of a Data API item (the API adds `type_`, the item's model type).
const pick = (item: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.map(k => [k, item[k]]));

// Every note with `title`, conflicts included, from the headless Data API (paginated).
const notesTitled = (dataApi: DataApi, title: string): Record<string, unknown>[] => {
	const found: Record<string, unknown>[] = [];
	for (let page = 1; page <= 50; page++) {
		const body = ok(dataApi.get(`/notes?fields=id,title,is_conflict&limit=100&page=${page}`), 'GET /notes');
		found.push(...(body.items as Record<string, unknown>[]).filter(n => n.title === title));
		if (!body.has_more) return found;
	}
	throw new Error('more than 50 pages of notes');
};

// Steps 1 and 2, shared by the walking skeleton and its NEG.
const createAndSyncNote = async (stack: StackState, account: Account, headlessService: HeadlessService, dataApi: DataApi): Promise<SkeletonNote> => {
	const uuid = randomUUID();
	const wanted = {
		title: `Walking skeleton ${uuid}`,
		body: `Walking skeleton body ${uuid}\n\nCreated through the headless REST Data API (M1-AC21): **Markdown**, Δ, ✓.`,
	};
	const note = await test.step('1. create the note through the headless REST Data API', async () => {
		const created = ok(dataApi.request('POST', '/notes', wanted), 'POST /notes');
		expect(created.id, 'the new note id').toMatch(/^[0-9a-f]{32}$/);
		const id = created.id as string;
		expect(pick(ok(dataApi.get(`/notes/${id}?fields=id,title,body`), 'GET /notes/:id'), ['id', 'title', 'body'])).toEqual({ id, ...wanted });
		return { id, ...wanted };
	});
	await test.step('2. one headless sync', async () => {
		await syncHeadlessOnce(stack, headlessService);
		// Data level: the server now holds the note, end-to-end encrypted (neither the title nor the uuid in clear).
		expect(await serverItemNames(stack, account), 'the server lists the note').toContain(`${note.id}.md`);
		const content = await serverItemContent(stack, account, `${note.id}.md`);
		expect(content.status).toBe(200);
		expect(content.text, 'the server copy is encrypted').toMatch(/^encryption_applied: 1$/m);
		expect(content.text.includes(uuid), 'the server copy carries no clear text of the note').toBe(false);
	});
	return note;
};

// Successful logins of the browser through this web container's public listener (Caddy's access log, redacted).
const browserLogins = (log: string, host: string): number => log.split('\n').filter(line => {
	try {
		const e = JSON.parse(line) as { request?: { method?: string; host?: string; uri?: string }; status?: number };
		return e.request?.method === 'POST' && e.request.host === host && e.request.uri === '/joplin-server/api/sessions' && e.status === 200;
	} catch {
		return false;
	}
}).length;

test.describe('M1-S7 walking skeleton', () => {
	test('M1-AC21 a note created through the headless Data API shows in the web app after E2EE unlock, and its body is intact', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp }) => {
		await requireUpstreamBundle(stack);
		const since = new Date().toISOString();
		const note = await createAndSyncNote(stack, e2eeAccount, headlessService, dataApi);
		const app = new JoplinWebApp(webApp.page);

		await test.step('3. configure the web app (fresh context) to sync with /joplin-server as the test user', async () => {
			expect(joplinServer.proxiedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/joplin-server$/);
			await configureJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			// The app's own first sync went through the proxy and fetched the master key, so it asks for the password ...
			await expect(app.decryptionBanner(), 'the web app synced and asks for the master password').toBeVisible({ timeout: firstSyncTimeoutMs });
			// ... and without it the note stays hidden (positive control for step 4).
			await expect(app.anyTextOf(note.title)).toHaveCount(0);
			// Data level: the browser logged in through this web container's public listener.
			const host = new URL(webApp.baseURL).host;
			expect(browserLogins(containerLog(stack, stack.containers.web ?? '', since), host), `POST /joplin-server/api/sessions → 200 from Host ${host} in the web access log`).toBeGreaterThan(0);
		});

		await test.step('4. enter the E2EE master password', async () => {
			await unlockE2ee(app, e2eeAccount);
		});

		await test.step('5. the note title is visible in the note list', async () => {
			await expect.poll(() => app.noteInList(note.title).isVisible(), { timeout: 3 * 60_000, intervals: [1_000] }).toBe(true);
		});

		await test.step('6. the body read back through the headless REST API equals the created body', async () => {
			// One more headless sync first, so whatever the web app changed after decrypting is in the headless profile.
			await syncHeadlessOnce(stack, headlessService);
			expect(pick(ok(dataApi.get(`/notes/${note.id}?fields=id,title,body,is_conflict`), 'GET /notes/:id'), ['id', 'title', 'body', 'is_conflict'])).toEqual({ id: note.id, title: note.title, body: note.body, is_conflict: 0 });
			expect(notesTitled(dataApi, note.title).map(n => n.id), 'exactly one note with this title (no conflict copy)').toEqual([note.id]);
		});
	});

	test('M1-AC21 NEG without the proxy\'s Host rewrite the web app reports a sync error and the note never appears', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webWithoutHostRewrite }) => {
		await requireUpstreamBundle(stack);
		const note = await createAndSyncNote(stack, e2eeAccount, headlessService, dataApi);
		const neg = webWithoutHostRewrite;

		await test.step('the only difference: the Host the server receives', async () => {
			// Positive control: the stack's own web container reaches the server.
			const through = (url: string): Promise<{ status: number; text: string }> => request({ port: Number.parseInt(new URL(url).port, 10), path: '/joplin-server/api/ping' });
			const good = await through(joplinServer.proxiedUrl);
			expect({ status: good.status, ok: good.text.includes('"status":"ok"') }).toEqual({ status: 200, ok: true });
			// The NEG container serves the same bundle, and its proxy reaches the server, which refuses the Host.
			const bad = await through(neg.url);
			expect({ status: bad.status, text: bad.text }).toEqual({ status: 404, text: `Invalid origin: http://${neg.host}` });
		});

		const itemsBefore = await serverItemNames(stack, e2eeAccount);
		const app = new JoplinWebApp(webApp.page);

		const firstError = await test.step('3. the same configuration through the web container without the Host rewrite', async () => {
			await configureJoplinServerSync(app, neg.url, `${neg.url}/joplin-server`, e2eeAccount);
			await app.openSidebar();
			// The web app reports the sync error: the server's "Invalid origin" for the browser's own Host.
			let report = '';
			await expect.poll(async () => {
				report = await app.syncReport();
				return report;
			}, { timeout: firstSyncTimeoutMs, intervals: [1_000] }).toMatch(new RegExp(`Last error: .*Invalid origin: http://${neg.host.replace(/\./g, '\\.')}`));
			return report;
		});

		await test.step(`the note never appears (and nothing asks for the master password) within ${negWindowMs / 1000} s`, async () => {
			await holdsFor('no trace of the note and no decryption banner', async () => {
				if ((await app.anyTextOf(note.title).count()) > 0) return `the note title "${note.title}" is in the page`;
				if ((await app.anyTextOf(decryptionBannerText).count()) > 0) return 'the decryption banner appeared (the master key was downloaded)';
				return undefined;
			}, { windowMs: negWindowMs, intervalMs: 1_000 });
			// Still failing for the same reason at the end of the window.
			expect(await app.syncReport()).toContain('Invalid origin');
			expect(firstError).toContain('Invalid origin');
		});

		await test.step('data level: the server got nothing from the web app', async () => {
			expect(await serverItemNames(stack, e2eeAccount)).toEqual(itemsBefore);
			expect(itemsBefore, 'the note the web app would have shown is on the server').toContain(`${note.id}.md`);
		});
	});
});
