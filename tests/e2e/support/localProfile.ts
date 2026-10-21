// The web app's local profile (OPFS of the app origin), searched for a needle, value-free (docs/test-plans/M2-S1.md D2).
// The result carries file paths and counts only, never file content.
import { waitFor } from '../../support/poll.ts';
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
