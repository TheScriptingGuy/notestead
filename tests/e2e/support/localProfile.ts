// The web app's local profile (OPFS of the app origin), searched for a needle, value-free (docs/test-plans/M2-S1.md D2).
// The result carries file paths and counts only, never file content.
import { holdsFor, waitFor } from '../../support/poll.ts';
import type { Page } from '@playwright/test';
import type { WebApp } from './fixtures.ts';

export interface ProfileScan {
	files: number;
	bytes: number;
	hits: string[];
	errors: string[];
}

// Closes the app page (the app's worker ends and its OPFS sync access handles are released), then reads the origin's OPFS
// from a same-origin page that runs no app code. The caller must not use the app page afterwards.
export const scanLocalProfile = async (webApp: WebApp, needle: string, opts?: { timeoutMs?: number }): Promise<ProfileScan> => {
	await webApp.page.close();
	const probe = await webApp.context.newPage();
	await probe.goto(new URL('/manifest.json', webApp.baseURL).href);
	let last: ProfileScan | undefined;
	try {
		return await waitFor('the local profile to be readable', async () => {
			const scan = await probe.evaluate(async n => {
				interface Handle { kind: string; name: string; entries?: () => AsyncIterable<[string, Handle]>; getFile?: () => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> }
				const g = globalThis as unknown as { navigator: { storage: { getDirectory: () => Promise<Handle> } }; TextEncoder: new () => { encode: (s: string) => Uint8Array } };
				const needleBytes = new g.TextEncoder().encode(n);
				const result: { files: number; bytes: number; hits: string[]; errors: string[] } = { files: 0, bytes: 0, hits: [], errors: [] };
				const contains = (data: Uint8Array): boolean => {
					outer: for (let i = 0; i + needleBytes.length <= data.length; i++) {
						for (let j = 0; j < needleBytes.length; j++) if (data[i + j] !== needleBytes[j]) continue outer;
						return true;
					}
					return false;
				};
				const walk = async (dir: Handle, path: string): Promise<void> => {
					for await (const [name, handle] of dir.entries?.() ?? []) {
						const p = `${path}/${name}`;
						if (handle.kind === 'directory') {
							await walk(handle, p);
						} else {
							try {
								const file = await handle.getFile?.();
								const data = new Uint8Array(await (file?.arrayBuffer() ?? Promise.resolve(new ArrayBuffer(0))));
								result.files++;
								result.bytes += data.length;
								if (contains(data)) result.hits.push(p);
							} catch (error) {
								result.errors.push(`${p}: ${(error as { name?: string }).name ?? 'error'}`);
							}
						}
					}
				};
				await walk(await g.navigator.storage.getDirectory(), '');
				return result;
			}, needle);
			last = scan;
			return scan.errors.length > 0 ? undefined : scan;
		}, { timeoutMs: opts?.timeoutMs ?? 30_000, intervalMs: 1_000 });
	} catch (error) {
		throw new Error(`${(error as Error).message} (last scan errors: ${JSON.stringify(last?.errors ?? [])})`);
	} finally {
		await probe.close();
	}
};

// The path of the first file that is the app's database (a .sqlite3 file, never its -journal) and holds `needle` as UTF-8, or
// undefined. The result carries the path only, never a byte or the needle (WEB-SQLITE-1, docs/test-plans/M2-S3.md WS-3).
export const findInDatabaseFile = (files: { path: string; bytes: Uint8Array }[], needle: string): { file: string } | undefined => {
	if (needle === '') return undefined;
	const wanted = Buffer.from(needle, 'utf8');
	for (const f of files) {
		if (!f.path.endsWith('.sqlite3')) continue;
		if (Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength).includes(wanted)) return { file: f.path };
	}
	return undefined;
};

// A second same-origin page of the context that runs no app code, for reading the app's OPFS while the app page stays open.
const openProbe = async (webApp: WebApp): Promise<Page> => {
	const probe = await webApp.context.newPage();
	try {
		await probe.goto(new URL('/manifest.json', webApp.baseURL).href);
	} catch (error) {
		await probe.close();
		throw error;
	}
	return probe;
};

// The app's *.sqlite3 files (never the journal) as the probe page reads them now; a file that cannot be read yet is counted.
const readDatabaseFiles = async (probe: Page): Promise<{ files: { path: string; bytes: Uint8Array }[]; unreadable: number }> => {
	const read = await probe.evaluate(async () => {
		interface Handle { kind: string; entries?: () => AsyncIterable<[string, Handle]>; getFile?: () => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> }
		const g = globalThis as unknown as { navigator: { storage: { getDirectory: () => Promise<Handle> } }; btoa: (s: string) => string };
		const out: { path: string; base64: string }[] = [];
		let unreadable = 0;
		const walk = async (dir: Handle, path: string): Promise<void> => {
			for await (const [name, handle] of dir.entries?.() ?? []) {
				const p = `${path}/${name}`;
				if (handle.kind === 'directory') {
					await walk(handle, p);
				} else if (p.endsWith('.sqlite3')) {
					try {
						const data = new Uint8Array(await (await handle.getFile?.())!.arrayBuffer());
						let binary = '';
						for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
						out.push({ path: p, base64: g.btoa(binary) });
					} catch {
						unreadable++;
					}
				}
			}
		};
		await walk(await g.navigator.storage.getDirectory(), '');
		return { files: out, unreadable };
	});
	return { files: read.files.map(f => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') })), unreadable: read.unreadable };
};

// After a UI edit and before any sync: the web app's own database file holds the new value (WEB-SQLITE-1). A lost save and a
// lost sync become different failures. There is no in-page API in the served bundle (window.joplin is __DEV__ only), so this
// reads the app's *.sqlite3 files from OPFS in a second same-origin page of the context while the app page stays open (the
// WS-3 feasibility run: the first probe read it, 0.6 s after the edit). A file that cannot be read yet counts as "not yet".
// Only the main database file is searched, never the -journal, so a rolled-back write is not found. The message names what
// was edited, never the value.
export const expectStoredLocally = async (webApp: WebApp, needle: string, what: string, opts?: { timeoutMs?: number }): Promise<void> => {
	const probe = await openProbe(webApp);
	try {
		await waitFor(what, async () => findInDatabaseFile((await readDatabaseFiles(probe)).files, needle), { timeoutMs: opts?.timeoutMs ?? 30_000, intervalMs: 250 });
	} catch {
		throw new Error(`${what} is not in the web app's own database (a lost save, WEB-SQLITE-1)`);
	} finally {
		await probe.close();
	}
};

// The opposite, for the L20 characterisation (WSQ-01, docs/test-plans/M2-S3.md D-W1): the needle is NOT in the database file for
// `holdMs`, read each second. A read that fails (a busy file) does not prove an absence: at least three files must have been
// read. On a find, the message is the flip text: upstream has changed what L20 documents.
export const expectNotStoredLocally = async (webApp: WebApp, needle: string, what: string, opts?: { holdMs?: number }): Promise<void> => {
	const probe = await openProbe(webApp);
	let reads = 0;
	try {
		await holdsFor(`${what} stays out of the web app's own database`, async () => {
			const r = await readDatabaseFiles(probe);
			reads += r.files.length;
			return findInDatabaseFile(r.files, needle) ? 'found' : undefined;
		}, { windowMs: opts?.holdMs ?? 15_000, intervalMs: 1_000 });
	} catch {
		throw new Error('L20 no longer reproduces at this pin: the edit survived a rolled-back settings batch. Upstream may have fixed issue A. Flip WSQ-01 to assert the edit is kept, and ask the architect to update L20.');
	} finally {
		await probe.close();
	}
	if (reads < 3) throw new Error(`the database file could not be read (${reads} reads): the absence of ${what} is not proven`);
};
