// Reads the member list of an uncompressed tar archive held in memory, without extracting anything, so `import`
// can check every member before a byte is written (M1-AC28). Understands POSIX ustar headers, pax extended headers
// (`x`, as GNU tar writes them for `package`; `g` only when it changes no path or size) and GNU long names (`L`/`K`).
// Extended headers are metadata, not members. Every other type flag is reported as a member of its own type, so the
// caller can refuse it by name.

export type TarMemberType = 'file' | 'directory' | 'symlink' | 'hard link' | 'character device' | 'block device' | 'FIFO' | 'contiguous file' | 'other';

export interface TarMember {
	// As recorded (pax `path`, GNU long name, or ustar prefix + name); not normalized.
	name: string;
	type: TarMemberType;
	typeFlag: string;
	linkName: string;
	size: number;
	// Offset of the member's content in the archive.
	offset: number;
}

const blockSize = 512;

const memberTypes: Record<string, TarMemberType> = {
	'0': 'file', '\0': 'file', '1': 'hard link', '2': 'symlink', '3': 'character device', '4': 'block device',
	'5': 'directory', '6': 'FIFO', '7': 'contiguous file',
};

const text = (header: Buffer, start: number, length: number): string => {
	const raw = header.subarray(start, start + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end < 0 ? length : end).toString('utf8');
};

// Octal (NUL- or space-terminated) or, when the high bit is set, GNU base-256.
const numeric = (header: Buffer, start: number, length: number, what: string): number => {
	const raw = header.subarray(start, start + length);
	if (raw[0] & 0x80) {
		if (raw[0] !== 0x80) throw new Error(`${what}: negative or oversized base-256 number`);
		let value = 0;
		for (const byte of raw.subarray(1)) value = value * 256 + byte;
		if (!Number.isSafeInteger(value)) throw new Error(`${what}: base-256 number too large`);
		return value;
	}
	const digits = raw.toString('latin1').replace(/^[ \0]+|[ \0]+$/g, '');
	if (digits === '') return 0;
	if (!/^[0-7]+$/.test(digits)) throw new Error(`${what}: invalid octal number ${JSON.stringify(digits)}`);
	return Number.parseInt(digits, 8);
};

// The header checksum treats its own field as eight spaces; historic writers summed signed bytes.
const checksumMatches = (header: Buffer, at: number): boolean => {
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < blockSize; i++) {
		const byte = i >= 148 && i < 156 ? 0x20 : header[i];
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}
	const recorded = numeric(header, 148, 8, `header checksum at byte ${at}`);
	return recorded === unsigned || recorded === signed;
};

// Pax records: "<length> <key>=<value>\n", where <length> counts the whole record.
const paxRecords = (data: Buffer, at: number): Map<string, string> => {
	const records = new Map<string, string>();
	let pos = 0;
	while (pos < data.length) {
		const space = data.indexOf(0x20, pos);
		const lengthText = space < 0 ? '' : data.subarray(pos, space).toString('latin1');
		const length = /^[1-9][0-9]*$/.test(lengthText) ? Number.parseInt(lengthText, 10) : NaN;
		if (!(length > space - pos + 1) || pos + length > data.length || data[pos + length - 1] !== 0x0a) {
			throw new Error(`malformed pax extended header at byte ${at}`);
		}
		const record = data.subarray(space + 1, pos + length - 1).toString('utf8');
		const eq = record.indexOf('=');
		if (eq <= 0) throw new Error(`malformed pax record ${JSON.stringify(record)} at byte ${at}`);
		records.set(record.slice(0, eq), record.slice(eq + 1));
		pos += length;
	}
	return records;
};

const paxSize = (value: string, at: number): number => {
	if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`invalid pax size ${JSON.stringify(value)} at byte ${at}`);
	return Number(value);
};

const cString = (data: Buffer): string => {
	const end = data.indexOf(0);
	return data.subarray(0, end < 0 ? data.length : end).toString('utf8');
};

export const readTar = (archive: Buffer): TarMember[] => {
	const members: TarMember[] = [];
	let pos = 0;
	let pax: Map<string, string> | null = null;
	let longName: string | null = null;
	let longLink: string | null = null;
	for (;;) {
		if (pos + blockSize > archive.length) throw new Error(`the archive ends at byte ${archive.length} without an end-of-archive block`);
		const header = archive.subarray(pos, pos + blockSize);
		if (header.every(byte => byte === 0)) {
			if (pax || longName !== null || longLink !== null) throw new Error(`an extended header at the end of the archive (byte ${pos}) describes no member`);
			return members;
		}
		if (!checksumMatches(header, pos)) throw new Error(`header checksum mismatch at byte ${pos}`);
		const typeFlag = String.fromCharCode(header[156]);
		let size = numeric(header, 124, 12, `size at byte ${pos}`);
		if (pax?.has('size')) size = paxSize(pax.get('size') ?? '', pos);
		const offset = pos + blockSize;
		if (offset + size > archive.length) throw new Error(`the archive is truncated: the member at byte ${pos} needs ${size} bytes`);
		const data = archive.subarray(offset, offset + size);
		const at = pos;
		pos = offset + Math.ceil(size / blockSize) * blockSize;

		if (typeFlag === 'x') {
			pax = paxRecords(data, at);
			continue;
		}
		if (typeFlag === 'g') {
			const global = paxRecords(data, at);
			for (const key of ['path', 'linkpath', 'size']) {
				if (global.has(key)) throw new Error(`a global pax header at byte ${at} sets "${key}" for every member; not supported`);
			}
			continue;
		}
		if (typeFlag === 'L') {
			longName = cString(data);
			continue;
		}
		if (typeFlag === 'K') {
			longLink = cString(data);
			continue;
		}

		const ustarPrefix = header.subarray(257, 263).toString('latin1') === 'ustar\0' ? text(header, 345, 155) : '';
		const headerName = ustarPrefix === '' ? text(header, 0, 100) : `${ustarPrefix}/${text(header, 0, 100)}`;
		members.push({
			name: pax?.get('path') ?? longName ?? headerName,
			type: memberTypes[typeFlag] ?? 'other',
			typeFlag,
			linkName: pax?.get('linkpath') ?? longLink ?? text(header, 157, 100),
			size,
			offset,
		});
		pax = null;
		longName = null;
		longLink = null;
	}
};

// Why a member or manifest path is unsafe to extract below a directory, or null. A leading `./` is allowed (and
// removed by normalizeMemberPath); a trailing `/` is allowed for directories.
export const memberPathProblem = (name: string): string | null => {
	if (name === '') return 'has an empty path';
	if (name.startsWith('/')) return 'has an absolute path';
	if (name.includes('\\')) return 'has a backslash in its path';
	const segments = normalizeMemberPath(name).split('/');
	if (segments.includes('..')) return 'has a \'..\' path segment';
	if (segments.some(segment => segment === '' || segment === '.')) return 'has an empty or \'.\' path segment';
	return null;
};

// Removes leading `./` and one trailing `/`.
export const normalizeMemberPath = (name: string): string => {
	let path = name;
	while (path.startsWith('./')) path = path.slice(2);
	return path.endsWith('/') ? path.slice(0, -1) : path;
};
