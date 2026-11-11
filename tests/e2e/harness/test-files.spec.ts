// M2-S3-FILES-01 (docs/test-plans/M2-S3.md D4): the files of the testFiles fixture reach a real browser byte for byte when
// given by path to a file input, and Chromium decodes the PNGs. A plain page on the web origin (a secure context, so
// crypto.subtle exists); no app code.
import { expect, test } from '../support/fixtures.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';

interface Read { name: string; size: number; type: string; sha256: string; width?: number; height?: number }

test.describe('M2-S3 generated test files in the browser', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-S3-FILES-01 a 5 MiB PNG, a 96x64 PNG and a 100 MiB binary given by path arrive with their sizes and sha256, and the PNGs decode', async ({ webApp, testFiles }) => {
		const { page } = webApp;
		const made = await test.step('1. generate', async () => {
			const started = Date.now();
			const made = {
				big: testFiles.png('nst-files-big.png', { width: 1280, height: 1364, totalBytes: 5 * 1024 * 1024 }),
				small: testFiles.png('nst-files-small.png', { width: 96, height: 64 }),
				bin: testFiles.binary('nst-files-bin.bin', 100 * 1024 * 1024),
			};
			const total = Object.values(made).reduce((n, f) => n + f.size, 0);
			test.info().annotations.push({ type: 'files', description: `${total} bytes generated in ${Date.now() - started} ms` });
			return made;
		});

		await test.step('2. a file input on the web origin', async () => {
			await page.goto(new URL('/manifest.json', webApp.baseURL).href);
			await page.setContent('<input type="file" multiple aria-label="Files">');
			expect(await page.evaluate(() => (globalThis as unknown as { isSecureContext: boolean }).isSecureContext)).toBe(true);
		});

		await test.step('3. given by path', async () => {
			await page.getByLabel('Files').setInputFiles([made.big.path, made.small.path, made.bin.path], { timeout: 60_000 });
		});

		await test.step('4. the browser holds the same bytes, and decodes the PNGs', async () => {
			const read = await page.evaluate(async (): Promise<Read[]> => {
				interface BrowserFile { name: string; size: number; type: string; arrayBuffer: () => Promise<ArrayBuffer> }
				const g = globalThis as unknown as {
					document: { querySelector: (s: string) => { files: ArrayLike<BrowserFile> } };
					crypto: { subtle: { digest: (a: string, d: ArrayBuffer) => Promise<ArrayBuffer> } };
					createImageBitmap: (f: BrowserFile) => Promise<{ width: number; height: number }>;
				};
				const input = g.document.querySelector('input[type=file]');
				const out: Read[] = [];
				for (const f of Array.from(input.files)) {
					const digest = new Uint8Array(await g.crypto.subtle.digest('SHA-256', await f.arrayBuffer()));
					const entry: Read = { name: f.name, size: f.size, type: f.type, sha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') };
					if (f.type === 'image/png') {
						const bitmap = await g.createImageBitmap(f);
						entry.width = bitmap.width;
						entry.height = bitmap.height;
					}
					out.push(entry);
				}
				return out;
			});
			expect(read).toHaveLength(3);
			expect(read[0]).toMatchObject({ name: 'nst-files-big.png', size: 5242880, sha256: made.big.sha256, width: 1280, height: 1364, type: 'image/png' });
			expect(read[1]).toMatchObject({ name: 'nst-files-small.png', size: 18564, sha256: made.small.sha256, width: 96, height: 64, type: 'image/png' });
			expect(read[2]).toMatchObject({ name: 'nst-files-bin.bin', size: 104857600, sha256: made.bin.sha256 });
			test.info().annotations.push({ type: 'files', description: `browser MIME of .bin: ${read[2].type}` });
		});
	});
});
