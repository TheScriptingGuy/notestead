// A minimal POSIX ustar writer, used to build the synthetic probe plugins (.jpl is a tar archive;
// docs/test-plans/M2-S4.md D7). Deterministic: mode 0644, uid/gid 0, mtime 0, no owner names. The independent oracle in the
// unit tests is the system's GNU tar.
export interface TarEntry { name: string; data: Buffer }

const block = 512;

const octal = (value: number, digits: number): string => value.toString(8).padStart(digits, '0');

const header = (entry: TarEntry): Buffer => {
	const name = Buffer.from(entry.name, 'utf8');
	if (entry.name === '') throw new Error('tar entry has an empty name');
	if (name.length > 100) throw new Error(`tar entry name is longer than 100 bytes: ${entry.name}`);
	if (entry.name.startsWith('/')) throw new Error(`tar entry name is an absolute path: ${entry.name}`);
	if (entry.name.split('/').includes('..')) throw new Error(`tar entry name has a ".." segment: ${entry.name}`);

	const h = Buffer.alloc(block, 0);
	const put = (text: string, at: number): void => {
		h.write(text, at, 'latin1');
	};
	name.copy(h, 0);
	put('0000644\0', 100);
	put('0000000\0', 108);
	put('0000000\0', 116);
	put(`${octal(entry.data.length, 11)}\0`, 124);
	put('00000000000\0', 136);
	put('        ', 148); // the checksum field counts as spaces while it is computed
	put('0', 156);
	put('ustar\0', 257);
	put('00', 263);
	let sum = 0;
	for (const byte of h) sum += byte;
	put(`${octal(sum, 6)}\0 `, 148);
	return h;
};

export const ustar = (entries: TarEntry[]): Buffer => {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		parts.push(header(entry));
		parts.push(entry.data);
		const pad = (block - (entry.data.length % block)) % block;
		if (pad) parts.push(Buffer.alloc(pad, 0));
	}
	parts.push(Buffer.alloc(2 * block, 0));
	return Buffer.concat(parts);
};
