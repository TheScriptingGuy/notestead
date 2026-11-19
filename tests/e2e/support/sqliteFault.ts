// A fault for the L20 characterisation (docs/test-plans/M2-S3.md D-W1, WEB-SQLITE-1; docs/worklog/WEB-SQLITE-1.md §4). L20: the web
// app's one SQLite connection runs a user's single `UPDATE` inside another caller's open transaction, so when that batch fails and
// `ROLLBACK` follows, the edit is undone although the screen shows it. The window is too short to hit by chance, so an init
// script holds one settings batch open on purpose: it rewrites the batch's `DELETE FROM settings` to an invalid statement and
// does not forward it until the test releases it. The real app code then takes its real failure path (a real SQLite error, a
// real `Could not save settings` line, a real `ROLLBACK`). The init script wraps `Worker.prototype.postMessage` and nothing else:
// every other message is forwarded unchanged. No Playwright import in the classifier (unit-tested: webSqlite.test.ts wsq-01…03).
import type { BrowserContext, Page } from '@playwright/test';

export type WorkerMessageKind = 'settings-delete' | 'notes-title-update' | 'begin' | 'other';

// sqlite-wasm's worker-1 message shape is { type: 'exec', args: { sql } }. Self-contained: it is also injected into the page.
export const classifyWorkerMessage = (msg: unknown): WorkerMessageKind => {
	if (msg === null || typeof msg !== 'object') return 'other';
	const m = msg as { type?: unknown; args?: { sql?: unknown } };
	if (m.type !== 'exec' || typeof m.args?.sql !== 'string') return 'other';
	const sql = m.args.sql.trim().replace(/\s+/g, ' ');
	// the app quotes its identifiers with backticks (`notes`, `title`)
	if (/^delete from [`"]?settings[`"]?(\s|$)/i.test(sql)) return 'settings-delete';
	if (/^update [`"]?notes[`"]? set [`"]?title[`"]?\b/i.test(sql)) return 'notes-title-update';
	if (/^begin\b/i.test(sql)) return 'begin';
	return 'other';
};

export interface FaultEvent { kind: 'begin' | 'held' | 'update-seen' | 'released' | 'rollback' | 'injected-reply'; t: number; error?: boolean }

// Runs inside the page: no closure over anything in this file; the classifier is passed in as an argument.
const script = (classify: (msg: unknown) => string): void => {
	interface Fault { events: FaultEvent[]; titles: { t: number; title: string }[]; armed: boolean; release?: () => void; injectedId?: unknown; replies: number; replyKeys?: string[] }
	const g = globalThis as unknown as { __nstFault?: Fault; __nstArmFault?: () => void; __nstReleaseFault?: () => void; Worker: { prototype: { postMessage: (...args: unknown[]) => unknown } }; performance: { now: () => number } };
	if (g.__nstFault) return;
	const fault: Fault = { events: [], titles: [], armed: false, replies: 0 };
	const listened = new WeakSet<object>();
	g.__nstFault = fault;
	g.__nstArmFault = () => { fault.armed = true; };
	g.__nstReleaseFault = () => {
		const release = fault.release;
		fault.release = undefined;
		if (release) release();
	};
	const original = g.Worker.prototype.postMessage;
	g.Worker.prototype.postMessage = function(this: unknown, ...args: unknown[]): unknown {
		try {
			// The worker's replies, listened to once per worker (WO-29b): { type, messageId, ... }; type 'error' is a failed statement.
			const worker = this as { addEventListener?: (type: string, fn: (e: { data?: { type?: unknown; messageId?: unknown } }) => void) => void };
			if (worker.addEventListener && !listened.has(worker as object)) {
				listened.add(worker as object);
				worker.addEventListener('message', e => {
					const data = e.data;
					if (!data || typeof data !== 'object' || data.messageId === undefined) return;
					fault.replies++;
					fault.replyKeys ??= Object.keys(data);
					if (fault.injectedId !== undefined && data.messageId === fault.injectedId) fault.events.push({ kind: 'injected-reply', t: g.performance.now(), error: data.type === 'error' });
				});
			}
			const message = args[0] as { args?: { sql?: string } };
			const kind = classify(message);
			if (kind === 'begin') fault.events.push({ kind: 'begin', t: g.performance.now() });
			if (/^rollback\b/i.test(String(message.args?.sql ?? '').trim())) fault.events.push({ kind: 'rollback', t: g.performance.now() });
			if (kind === 'notes-title-update') {
				// the bound title stays in page memory (never logged): fullTitleSeen compares it in the page (WO-29a)
				const t = g.performance.now();
				const bind = (message.args as { bind?: unknown } | undefined)?.bind;
				fault.events.push({ kind: 'update-seen', t });
				fault.titles.push({ t, title: Array.isArray(bind) ? String(bind[0]) : '' });
			}
			if (kind === 'settings-delete' && fault.armed && !fault.release && message.args) {
				fault.armed = false;
				fault.injectedId = (message as { messageId?: unknown }).messageId;
				message.args.sql = 'DELETE FROM settings_nst_missing_table';
				fault.events.push({ kind: 'held', t: g.performance.now() });
				const self = this;
				fault.release = () => {
					fault.events.push({ kind: 'released', t: g.performance.now() });
					original.apply(self, args);
				};
				return undefined;
			}
		} catch {
			// never break the app's own message
		}
		return original.apply(this, args);
	};
};

// Installs the fault in every frame of every page of the context, before any page script. It does nothing until the test calls
// __nstArmFault() in the page; then it holds the next settings batch's DELETE until __nstReleaseFault().
export const installSettingsFault = async (context: BrowserContext): Promise<void> => {
	await context.addInitScript({ content: `(${script.toString()})(${classifyWorkerMessage.toString()});` });
};

export const readFault = async (page: Page): Promise<FaultEvent[]> =>
	page.evaluate(() => (globalThis as unknown as { __nstFault?: { events: FaultEvent[] } }).__nstFault?.events ?? []);
export const armFault = async (page: Page): Promise<void> => {
	await page.evaluate(() => (globalThis as unknown as { __nstArmFault?: () => void }).__nstArmFault?.());
};
export const releaseFault = async (page: Page): Promise<void> => {
	await page.evaluate(() => (globalThis as unknown as { __nstReleaseFault?: () => void }).__nstReleaseFault?.());
};

export interface ReleaseEvent { kind: 'held' | 'update-seen'; t: number; fullTitle: boolean }

// The held and update events, each update marked by an in-page comparison of its bound title with `expected`: the title never
// leaves the page, only a boolean does (WO-29a).
export const fullTitleSeen = async (page: Page, expected: string): Promise<ReleaseEvent[]> =>
	page.evaluate(title => {
		const fault = (globalThis as unknown as { __nstFault?: { events: { kind: string; t: number }[]; titles: { t: number; title: string }[] } }).__nstFault;
		if (!fault) return [];
		return fault.events.filter(e => e.kind === 'held' || e.kind === 'update-seen').map(e => ({
			kind: e.kind as 'held' | 'update-seen', t: e.t, fullTitle: e.kind === 'update-seen' && fault.titles.some(x => x.t === e.t && x.title === title),
		}));
	}, expected);

// When WSQ-01 releases the held settings batch (WO-29a): a full-title UPDATE went to the worker after the hold, and no later UPDATE
// (full or not) has been seen for `quietMs` (3 x upstream's 500 ms save queue), so no save of the title is still pending.
// quietMs 1_500 = 3 x upstream's 500 ms AsyncActionQueue save interval (Note.tsx saveActionQueue): it depends on that upstream value (M2-S3 r1 F6).
export const releaseReady = (events: ReleaseEvent[], now: number, quietMs = 1_500): 'wait' | 'release' => {
	const held = events.find(e => e.kind === 'held');
	if (!held) return 'wait';
	const updates = events.filter(e => e.kind === 'update-seen' && e.t > held.t);
	if (!updates.some(e => e.fullTitle)) return 'wait';
	const last = Math.max(...updates.map(e => e.t));
	return now - last >= quietMs ? 'release' : 'wait';
};

// How many replies carrying a messageId the page has seen from the SQLite worker, and their keys (never values): the feasibility
// check of the reply listener (WO-29b).
export const replyShape = async (page: Page): Promise<{ replies: number; keys: string[] }> =>
	page.evaluate(() => {
		const f = (globalThis as unknown as { __nstFault?: { replies: number; replyKeys?: string[] } }).__nstFault;
		return { replies: f?.replies ?? 0, keys: f?.replyKeys ?? [] };
	});

export interface RollbackEvent { kind: string; t: number; error?: boolean }

// 'yes' when the held batch failed and was rolled back, as the worker's own replies show it (WO-29b): the injected statement's
// reply (matched by messageId) is an error, and a ROLLBACK was posted after the release. Otherwise what is missing.
export const batchRolledBack = (events: RollbackEvent[]): string => {
	const held = events.find(e => e.kind === 'held');
	const released = events.find(e => e.kind === 'released' && held && e.t >= held.t);
	if (!held || !released) return 'the settings batch was not held and released';
	const reply = events.find(e => e.kind === 'injected-reply' && e.t >= released.t);
	if (!reply) return 'no reply to the injected statement yet';
	if (!reply.error) return 'the injected statement did not fail';
	return events.some(e => e.kind === 'rollback' && e.t > released.t) ? 'yes' : 'no ROLLBACK after the release';
};
