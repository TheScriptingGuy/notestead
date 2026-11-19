// The OPFS file probe (tests/e2e/support/localProfile.ts `localFilesNamed`; docs/test-plans/M2-S4.md, harness items): lists every
// file of the origin's OPFS with a given base name, with its size and sha256, and never its content. A plain same-origin page
// with no account and no app code. The decoy under another directory shows that two files of one name are told apart.
import { createHash } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import type { WebApp } from '../support/fixtures.ts';
import { localFilesNamed } from '../support/localProfile.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';

const bytesOf = (n: number): number[] => Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
const sha256 = (data: number[]): string => createHash('sha256').update(Buffer.from(data)).digest('hex');

const writeOpfs = async (webApp: WebApp): Promise<void> => {
	await webApp.page.goto(new URL('/manifest.json', webApp.baseURL).href);
	await webApp.page.evaluate(async ({ big, small }) => {
		interface Dir { getDirectoryHandle: (name: string, o: { create: boolean }) => Promise<Dir>; getFileHandle: (name: string, o: { create: boolean }) => Promise<{ createWritable: () => Promise<{ write: (d: Uint8Array) => Promise<void>; close: () => Promise<void> }> }> }
		const g = globalThis as unknown as { navigator: { storage: { getDirectory: () => Promise<Dir> } } };
		const put = async (dirs: string[], name: string, data: number[]): Promise<void> => {
			let dir = await g.navigator.storage.getDirectory();
			for (const d of dirs) dir = await dir.getDirectoryHandle(d, { create: true });
			const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
			await w.write(new Uint8Array(data));
			await w.close();
		};
		await put(['joplin-web', 'app', 'plugins'], 'x.jpl', big);
		await put(['joplin-web', 'other'], 'x.jpl', small);
	}, { big: bytesOf(3000), small: bytesOf(5) });
};

test.describe('OPFS file probe', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-S4-OPFS-01 localFilesNamed lists every OPFS file with that name, with size and sha256', async ({ stack, webApp }) => {
		await requireUpstreamBundle(stack, 'M2-S4');
		await writeOpfs(webApp);
		const files = (await localFilesNamed(webApp, 'x.jpl')).sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
		expect(files).toEqual([
			{ path: '/joplin-web/app/plugins/x.jpl', size: 3000, sha256: sha256(bytesOf(3000)) },
			{ path: '/joplin-web/other/x.jpl', size: 5, sha256: sha256(bytesOf(5)) },
		]);
	});

	test('M2-S4-OPFS-02 an absent name gives an empty list', async ({ stack, webApp }) => {
		await requireUpstreamBundle(stack, 'M2-S4');
		await writeOpfs(webApp);
		expect(await localFilesNamed(webApp, 'absent.jpl')).toEqual([]);
	});
});
