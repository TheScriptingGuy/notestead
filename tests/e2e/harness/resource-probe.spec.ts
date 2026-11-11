// M2-S3-RES-01 (docs/test-plans/M2-S3.md D4, D5): resources created through the headless Data API come back with their metadata
// and digest, the server holds them encrypted, and no body leaves the headless container (the probe returns metadata and a
// hash only). Stack and the test's own headless service; no browser.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ok, pick } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { serverItemContent, serverItemNames, syncHeadlessOnce } from '../../stack/stack.ts';
// A namespace import: serverItemDigest does not exist yet (the RED), and a named import would fail at ESM link time before any step.
import * as stackApi from '../../stack/stack.ts';

test.describe('M2-S3 resource probe', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-S3-RES-01 resources created through the headless Data API come back with their metadata and bytes, the server holds them encrypted, and no body leaves the container', async ({ stack, e2eeAccount, headlessService, dataApi, testFiles }) => {
		const run = randomBytes(4).toString('hex');
		const meta = 'id,title,mime,size,file_extension';
		const bin = testFiles.binary(`nst-probe-${run}.bin`, 40 * 1024);
		const png = testFiles.png(`nst-probe-${run}.png`, { width: 96, height: 64 });
		let id = '';
		let pngId = '';

		await test.step('1. a binary through POST /resources', async () => {
			const r = dataApi.createResource({ title: bin.name, fileName: bin.name, mime: 'application/octet-stream', bytes: readFileSync(bin.path) });
			expect(r.error).toBeUndefined();
			expect(r.status).toBe(200);
			id = String((r.body as { id: unknown }).id);
			expect(id).toMatch(/^[0-9a-f]{32}$/);
			expect(JSON.stringify(r).length, 'the response is metadata only').toBeLessThan(2000);
		});

		await test.step('2. its metadata and its bytes', async () => {
			expect(pick(ok(dataApi.get(`/resources/${id}?fields=${meta}`), 'GET the resource'), meta.split(','))).toEqual({ id, title: bin.name, mime: 'application/octet-stream', size: 40960, file_extension: 'bin' });
			expect(pick(dataApi.fileDigest(id) as unknown as Record<string, unknown>, ['status', 'sha256', 'size'])).toEqual({ status: 200, sha256: bin.sha256, size: 40960 });
			expect(JSON.stringify(dataApi.fileDigest(id)).length).toBeLessThan(400);
		});

		await test.step('3. the PNG of M2-AC7b', async () => {
			const r = dataApi.createResource({ title: png.name, fileName: png.name, mime: 'image/png', bytes: readFileSync(png.path) });
			expect(r.status).toBe(200);
			pngId = String((r.body as { id: unknown }).id);
			expect(pick(ok(dataApi.get(`/resources/${pngId}?fields=${meta}`), 'GET the PNG resource'), ['title', 'mime', 'size', 'file_extension'])).toEqual({ title: png.name, mime: 'image/png', size: 18564, file_extension: 'png' });
			expect(pick(dataApi.fileDigest(pngId) as unknown as Record<string, unknown>, ['status', 'sha256', 'size'])).toEqual({ status: 200, sha256: png.sha256, size: png.size });
		});

		await test.step('4. NEG: an unknown id', async () => {
			const unknown = dataApi.fileDigest('0'.repeat(32));
			expect(unknown.status).toBe(404);
			expect(unknown.sha256).not.toBe(bin.sha256);
			expect(() => dataApi.fileDigest('../etc')).toThrow(/32 hex/);
		});

		await test.step('5. the server holds the blobs encrypted', async () => {
			await syncHeadlessOnce(stack, headlessService);
			const names = await serverItemNames(stack, e2eeAccount);
			expect(names).toContain(`.resource/${id}`);
			expect(names).toContain(`${id}.md`);
			const d = await stackApi.serverItemDigest(stack, e2eeAccount, `.resource/${id}`, { headBytes: 5 });
			expect(d.status).toBe(200);
			expect(d.head).toBe('JED01');
			expect(d.sha256).not.toBe(bin.sha256);
			expect(d.size).toBeGreaterThan(40960);
			expect((await serverItemContent(stack, e2eeAccount, `${id}.md`)).text).toMatch(/^encryption_applied: 1$/m);
		});

		await test.step('6. serverItemDigest agrees with serverItemContent', async () => {
			const content = await serverItemContent(stack, e2eeAccount, `${id}.md`);
			const bytes = Buffer.from(content.text, 'utf8');
			const d = await stackApi.serverItemDigest(stack, e2eeAccount, `${id}.md`);
			expect(d.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
			expect(d.size).toBe(bytes.length);
		});
	});
});
