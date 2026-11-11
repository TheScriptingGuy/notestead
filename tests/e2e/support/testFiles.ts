// Large and binary test files, generated at test time from a seed (docs/test-plans/M2-S3.md D4): never committed, written
// outside test-results/, hashed while they are written. The bytes are a ChaCha20 keystream keyed by sha256 of the seed, so a
// seed gives the same bytes on every Node version and architecture (files-01's golden values). The PNG is 8-bit RGB with
// stored (uncompressed) deflate blocks, so its size is known in advance; a private ancillary chunk "nsTt" pads it to an
// exact size. Unit tests: tests/unit/harness/testFiles.test.ts.
import { createCipheriv, createHash } from 'node:crypto';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

export interface GeneratedFile { name: string; path: string; seed: string; size: number; sha256: string; width?: number; height?: number }

export const testBytes = (seed: string): ((count: number) => Buffer) => {
	const cipher = createCipheriv('chacha20', createHash('sha256').update(`nst-test-bytes\0${seed}`, 'utf8').digest(), Buffer.alloc(16));
	return count => cipher.update(Buffer.alloc(count));
};

const u32 = (n: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0);
	return b;
};
const chunk = (type: string, data: Buffer): Buffer => {
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	return Buffer.concat([u32(data.length), typed, u32(zlib.crc32(typed))]);
};
const adler32 = (buf: Buffer): number => {
	let a = 1;
	let b = 0;
	for (const byte of buf) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
};
// zlib header 78 01, then stored blocks of at most 65535 bytes (BFINAL on the last), then the Adler-32 of the data.
const storedZlib = (raw: Buffer): Buffer => {
	const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
	for (let off = 0; off < raw.length; off += 65535) {
		const len = Math.min(65535, raw.length - off);
		const head = Buffer.alloc(5);
		head[0] = off + len >= raw.length ? 1 : 0;
		head.writeUInt16LE(len, 1);
		head.writeUInt16LE(~len & 0xffff, 3);
		parts.push(head, raw.subarray(off, off + len));
	}
	parts.push(u32(adler32(raw)));
	return Buffer.concat(parts);
};

export const pngBytes = (seed: string, opts: { width: number; height: number; totalBytes?: number }): Buffer => {
	const { width, height } = opts;
	const next = testBytes(seed);
	const row = 1 + 3 * width;
	const raw = Buffer.alloc(row * height);
	for (let y = 0; y < height; y++) next(3 * width).copy(raw, y * row + 1); // filter byte 0 stays 0
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour (RGB)
	const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]);
	const idat = chunk('IDAT', storedZlib(raw));
	const iend = chunk('IEND', Buffer.alloc(0));
	const base = head.length + idat.length + iend.length;
	const pad = opts.totalBytes === undefined ? 0 : opts.totalBytes - base;
	if (pad === 0) return Buffer.concat([head, idat, iend]);
	if (pad < 12) throw new Error(`a ${width}x${height} PNG cannot be padded to ${opts.totalBytes} bytes: it needs ${base}, and a padding chunk takes at least 12`);
	return Buffer.concat([head, chunk('nsTt', testBytes(`${seed}/pad`)(pad - 12)), idat, iend]);
};

const safeName = (name: string): string => {
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`unsafe file name: ${JSON.stringify(name)}`);
	return name;
};

export const writePng = (dir: string, name: string, seed: string, opts: { width: number; height: number; totalBytes?: number }): GeneratedFile => {
	const path = join(dir, safeName(name));
	const bytes = pngBytes(seed, opts);
	writeFileSync(path, bytes, { mode: 0o600 });
	return { name, path, seed, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: opts.width, height: opts.height };
};

// Streamed in 1 MiB chunks, hashed as written: memory stays flat for 100 MiB.
export const writeBinary = (dir: string, name: string, seed: string, size: number): GeneratedFile => {
	const path = join(dir, safeName(name));
	const next = testBytes(seed);
	const hash = createHash('sha256');
	const fd = openSync(path, 'w', 0o600);
	try {
		for (let left = size; left > 0;) {
			const part = next(Math.min(left, 1024 * 1024));
			hash.update(part);
			writeSync(fd, part);
			left -= part.length;
		}
	} finally {
		closeSync(fd);
	}
	return { name, path, seed, size, sha256: hash.digest('hex') };
};
