// SPDX licence expressions and the declared licence of a package manifest (ADR-0009 A6, A8, A9; M1-AC24).
// Grammar (SPDX 2.3 Annex D): `AND` binds tighter than `OR`, parentheses group, `WITH` attaches an exception to a
// single licence, `+` means "or later". Operators are upper case, as in the SPDX specification and npm's validator.

export type SpdxNode =
	| { type: 'licence'; id: string; plus: boolean; exception: string | null }
	| { type: 'and' | 'or'; left: SpdxNode; right: SpdxNode };

const idPattern = /^(?:DocumentRef-[A-Za-z0-9.-]+:)?[A-Za-z0-9][A-Za-z0-9.-]*\+?$/;
const operators = new Set(['AND', 'OR', 'WITH']);

const tokenize = (text: string): string[] | null => {
	const tokens: string[] = [];
	for (const match of text.matchAll(/\s*([()]|[^\s()]+)\s*/gy)) tokens.push(match[1]);
	return tokens.join('') === text.replace(/\s+/g, '') ? tokens : null;
};

// Parses an SPDX licence expression; null when it is not one (for example `Apache 2` or `SEE LICENSE IN …`).
export const parseSpdx = (text: string): SpdxNode | null => {
	const tokens = tokenize(text.trim());
	if (!tokens || tokens.length === 0) return null;
	let position = 0;
	const peek = (): string | undefined => tokens[position];

	const parseOr = (): SpdxNode | null => {
		let left = parseAnd();
		while (left && peek() === 'OR') {
			position++;
			const right = parseAnd();
			left = right ? { type: 'or', left, right } : null;
		}
		return left;
	};
	const parseAnd = (): SpdxNode | null => {
		let left = parseAtom();
		while (left && peek() === 'AND') {
			position++;
			const right = parseAtom();
			left = right ? { type: 'and', left, right } : null;
		}
		return left;
	};
	const parseAtom = (): SpdxNode | null => {
		const token = peek();
		if (token === undefined || token === ')' || operators.has(token)) return null;
		position++;
		if (token === '(') {
			const inner = parseOr();
			if (peek() !== ')') return null;
			position++;
			return inner;
		}
		if (!idPattern.test(token)) return null;
		const plus = token.endsWith('+');
		let exception: string | null = null;
		if (peek() === 'WITH') {
			position++;
			const name = peek();
			if (name === undefined || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name) || operators.has(name)) return null;
			position++;
			exception = name;
		}
		return { type: 'licence', id: plus ? token.slice(0, -1) : token, plus, exception };
	};

	const node = parseOr();
	return node && position === tokens.length ? node : null;
};

// The licence IDs of an expression, in order of appearance (as written, without `+`).
export const spdxIds = (node: SpdxNode): string[] =>
	node.type === 'licence' ? [node.id] : [...spdxIds(node.left), ...spdxIds(node.right)];

// ADR-0009 allow-list, with A8 (Python-2.0, Unlicense, Zlib, CC-BY-4.0). The GNU entries stand for their family:
// `-only`, `-or-later` and `+` variants of an allowed licence are allowed (so `LGPL-3.0-or-later` passes, and
// `GPL-2.0-only` does not). An SPDX ID joins this list only through an ADR-0009 amendment.
export const allowList: readonly string[] = [
	'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0',
	'AGPL-3.0', 'GPL-3.0', 'LGPL-3.0',
	'CC0-1.0', '0BSD', 'BlueOak-1.0.0',
	'Python-2.0', 'Unlicense', 'Zlib', 'CC-BY-4.0',
];
const allowed = new Set(allowList.map(id => id.toLowerCase()));

// SPDX IDs are case-insensitive. A licence with a `WITH` exception is never on the allow-list (A8: exceptions are
// reviewed per package).
export const isAllowedLicence = (node: SpdxNode): boolean => {
	if (node.type !== 'licence') {
		return node.type === 'and'
			? isAllowedLicence(node.left) && isAllowedLicence(node.right)
			: isAllowedLicence(node.left) || isAllowedLicence(node.right);
	}
	if (node.exception !== null) return false;
	return allowed.has(node.id.replace(/-(only|or-later)$/i, '').toLowerCase());
};

export interface DeclaredLicence {
	// The declared licence: the `license` string exactly as declared, or the expression derived from a legacy form.
	// null when nothing usable is declared.
	expression: string | null;
	// Set for the legacy forms (ADR-0009 A9).
	legacy: 'licenses array' | 'license object' | null;
}

const typeOf = (value: unknown): string | null => {
	const type = typeof value === 'string' ? value : (value !== null && typeof value === 'object' ? (value as { type?: unknown }).type : undefined);
	return typeof type === 'string' && type.trim() !== '' ? type.trim() : null;
};

// ADR-0009 A9: a legacy `licenses` array is the OR of its entries' types (objects with `type`, or plain strings); a
// legacy `license` object is its `type`. An entry without a usable type makes the whole form count as missing.
export const declaredLicence = (manifest: Record<string, unknown>): DeclaredLicence => {
	const { license, licenses } = manifest;
	if (typeof license === 'string') return { expression: license.trim() === '' ? null : license, legacy: null };
	if (license !== undefined) return { expression: typeOf(license), legacy: 'license object' };
	if (Array.isArray(licenses)) {
		const types = licenses.map(typeOf);
		if (types.length === 0 || types.some(type => type === null)) return { expression: null, legacy: 'licenses array' };
		const terms = (types as string[]).map(type => /\s/.test(type) && !/^\(.*\)$/.test(type) ? `(${type})` : type);
		return { expression: terms.length === 1 ? types[0] : `(${terms.join(' OR ')})`, legacy: 'licenses array' };
	}
	return { expression: null, legacy: null };
};
