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

export interface FaultEvent { kind: 'begin' | 'held' | 'update-seen' | 'released' | 'rollback'; t: number }

// Runs inside the page: no closure over anything in this file; the classifier is passed in as an argument.
const script = (classify: (msg: unknown) => string): void => {
	interface Fault { events: FaultEvent[]; armed: boolean; release?: () => void }
	const g = globalThis as unknown as { __nstFault?: Fault; __nstArmFault?: () => void; __nstReleaseFault?: () => void; Worker: { prototype: { postMessage: (...args: unknown[]) => unknown } }; performance: { now: () => number } };
	if (g.__nstFault) return;
	const fault: Fault = { events: [], armed: false };
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
			const message = args[0] as { args?: { sql?: string } };
			const kind = classify(message);
			if (kind === 'begin') fault.events.push({ kind: 'begin', t: g.performance.now() });
			if (/^rollback\b/i.test(String(message.args?.sql ?? '').trim())) fault.events.push({ kind: 'rollback', t: g.performance.now() });
			if (kind === 'notes-title-update') fault.events.push({ kind: 'update-seen', t: g.performance.now() });
			if (kind === 'settings-delete' && fault.armed && !fault.release && message.args) {
				fault.armed = false;
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
