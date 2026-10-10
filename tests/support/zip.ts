// A minimal zip reader and writer (node:zlib only, no dependency) for the harness: Playwright traces are zip files, and
// the harness redacts their entries before anything is kept (tests/support/redact.ts) and the M1-AC20 self-test reads
// them back. Supports stored and deflated entries as Playwright writes them (data descriptors included, through the
// central directory). Zip64 archives are refused: a trace that large is a harness bug, not something to redact.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
	name: string;
	data: Buffer;
}

const eocdSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;

const findEndOfCentralDirectory = (zip: Buffer): number => {
	// The EOCD record is 22 bytes plus a comment of at most 65535 bytes.
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
		if (zip.readUInt32LE(i) === eocdSignature) return i;
	}
	throw new Error('not a zip file: no end-of-central-directory record');
};

export const readZip = (zip: Buffer): ZipEntry[] => {
	const eocd = findEndOfCentralDirectory(zip);
	const count = zip.readUInt16LE(eocd + 10);
	const centralOffset = zip.readUInt32LE(eocd + 16);
	if (count === 0xffff || centralOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
	const entries: ZipEntry[] = [];
	let p = centralOffset;
	for (let i = 0; i < count; i++) {
		if (zip.readUInt32LE(p) !== centralSignature) throw new Error(`corrupt zip: no central directory entry at ${p}`);
		const method = zip.readUInt16LE(p + 10);
		const compressedSize = zip.readUInt32LE(p + 20);
		const nameLength = zip.readUInt16LE(p + 28);
		const extraLength = zip.readUInt16LE(p + 30);
		const commentLength = zip.readUInt16LE(p + 32);
		const localOffset = zip.readUInt32LE(p + 42);
		const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
		if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
		if (zip.readUInt32LE(localOffset) !== localSignature) throw new Error(`corrupt zip: no local header for ${name}`);
		const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
		const raw = zip.subarray(dataStart, dataStart + compressedSize);
		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = inflateRawSync(raw);
		else throw new Error(`zip entry ${name} uses unsupported compression method ${method}`);
		entries.push({ name, data });
		p += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
};

export const writeZip = (entries: ZipEntry[]): Buffer => {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const compressed = deflateRawSync(entry.data);
		const crc = crc32(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(localSignature, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 names, no data descriptor
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt32LE(0, 10); // time, date
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(centralSignature, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(0, 12);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, compressed);
		centrals.push(central, name);
		offset += local.length + name.length + compressed.length;
	}
	const centralDirectory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(eocdSignature, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDirectory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralDirectory, eocd]);
};
