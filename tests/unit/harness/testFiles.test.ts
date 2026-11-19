// Seeded test files (tests/e2e/support/testFiles.ts; docs/test-plans/M2-S3.md D4): a ChaCha20 keystream fixed by its seed, a PNG
// of known structure and exact size, and a streamed binary hashed as it is written. The goldens were computed by the planner.
import { afterEach, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { pngBytes, testBytes, writeBinary, writePng } from '../../e2e/support/testFiles.ts';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface Chunk { type: string; data: Buffer; crc: number; crcOk: boolean }
// 8-byte signature, then chunks of length (u32be), type, data and CRC.
const parsePng = (png: Buffer): { signature: string; chunks: Chunk[] } => {
	const chunks: Chunk[] = [];
	let off = 8;
	while (off < png.length) {
		const len = png.readUInt32BE(off);
		const type = png.subarray(off + 4, off + 8);
		const data = png.subarray(off + 8, off + 8 + len);
		const crc = png.readUInt32BE(off + 8 + len);
		chunks.push({ type: type.toString('ascii'), data, crc, crcOk: crc === zlib.crc32(Buffer.concat([type, data])) });
		off += 12 + len;
	}
	return { signature: png.subarray(0, 8).toString('hex'), chunks };
};

describe('test files', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	test('files-01 the keystream is fixed by its seed and independent of chunking', () => {
		expect(testBytes('golden')(16).toString('hex')).toBe('3aa4d19b823f298be72bbf7e3449c3ff');
		const mib = 1048576;
		const next = testBytes('golden');
		const chunked = Buffer.concat([next(1), next(100_000), next(mib - 100_001)]);
		expect(sha256(chunked)).toBe('734d4d8ec0c342121a8e504345b0461374523c9ee44beb0931ae6101ec9be7ac');
		expect(sha256(testBytes('golden')(mib))).toBe('734d4d8ec0c342121a8e504345b0461374523c9ee44beb0931ae6101ec9be7ac');
		expect(testBytes('other')(16).toString('hex')).not.toBe('3aa4d19b823f298be72bbf7e3449c3ff');
	});

	test('files-02 a PNG\'s structure', () => {
		const png = pngBytes('golden', { width: 4, height: 3 });
		expect(png).toHaveLength(107);
		expect(sha256(png)).toBe('312882492b6c90b74f20e10a7f0c72e4d84a2c148e1cac34b10a4f8264b1f676');
		const parsed = parsePng(png);
		expect(parsed.signature).toBe('89504e470d0a1a0a');
		expect(parsed.chunks.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
		expect(parsed.chunks.map(c => c.crcOk)).toEqual([true, true, true]);
		const ihdr = parsed.chunks[0].data;
		expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ...ihdr.subarray(8)]).toEqual([4, 3, 8, 2, 0, 0, 0]);
		const raw = zlib.inflateSync(parsed.chunks[1].data);
		const next = testBytes('golden');
		const expected = Buffer.concat([0, 1, 2].map(() => Buffer.concat([Buffer.from([0]), next(12)])));
		expect(raw.equals(expected)).toBe(true);
	});

	test('files-03 padding to an exact size', () => {
		const total = 5 * 1024 * 1024;
		// both sides at most 1920 px: upstream's Resource.IMAGE_MAX_DIMENSION, so the app never offers to resize the image
		const big = pngBytes('x', { width: 1280, height: 1364, totalBytes: total });
		expect(big).toHaveLength(5_242_880);
		const parsed = parsePng(big);
		expect(parsed.chunks.map(c => c.type)).toEqual(['IHDR', 'nsTt', 'IDAT', 'IEND']);
		expect(parsed.chunks[1].data).toHaveLength(3281);
		expect(parsed.chunks.every(c => c.crcOk)).toBe(true);
		const base = pngBytes('x', { width: 1280, height: 1364 }).length;
		expect(base).toBe(5_239_587);
		expect(parsePng(pngBytes('x', { width: 1280, height: 1364, totalBytes: base })).chunks.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
		expect(() => pngBytes('x', { width: 1280, height: 1364, totalBytes: base - 1 })).toThrow(/cannot be padded/);
		expect(() => pngBytes('x', { width: 1280, height: 1364, totalBytes: base + 5 })).toThrow(/cannot be padded/);
	});

	test('files-04 a streamed binary', () => {
		dir = mkdtempSync(join(tmpdir(), 'nst-unit-files-'));
		const f = writeBinary(dir, 'nst-x.bin', 'seed-a', 3 * 1024 * 1024 + 5);
		expect(f.size).toBe(3_145_733);
		expect(statSync(f.path).size).toBe(f.size);
		const onDisk = readFileSync(f.path);
		expect(sha256(onDisk)).toBe(f.sha256);
		expect(sha256(testBytes('seed-a')(f.size))).toBe(f.sha256);
		for (const name of ['../x', 'A.bin', '']) expect(() => writeBinary(dir ?? '', name, 's', 10)).toThrow(/unsafe file name/);
	});

	test('files-05 writePng', () => {
		dir = mkdtempSync(join(tmpdir(), 'nst-unit-files-'));
		const a = writePng(dir, 'nst-a.png', 's1', { width: 96, height: 64 });
		expect(a).toMatchObject({ name: 'nst-a.png', path: join(dir, 'nst-a.png'), seed: 's1', size: 18564, width: 96, height: 64 });
		expect(a.sha256).toBe(sha256(readFileSync(a.path)));
		expect(writePng(dir, 'nst-b.png', 's1', { width: 96, height: 64 }).sha256).toBe(a.sha256);
		expect(writePng(dir, 'nst-c.png', 's2', { width: 96, height: 64 }).sha256).not.toBe(a.sha256);
	});
});
