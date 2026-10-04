import { declaredLicence, isAllowedLicence, parseSpdx, spdxIds } from './spdx.ts';

const allowed = (text: string): boolean => {
	const node = parseSpdx(text);
	return node !== null && isAllowedLicence(node);
};

describe('spdx', () => {
	test('parses with AND binding tighter than OR, parentheses, WITH and +', () => {
		expect(parseSpdx('SSPL-1.0 AND MIT OR ISC')).toEqual({
			type: 'or',
			left: { type: 'and', left: { type: 'licence', id: 'SSPL-1.0', plus: false, exception: null }, right: { type: 'licence', id: 'MIT', plus: false, exception: null } },
			right: { type: 'licence', id: 'ISC', plus: false, exception: null },
		});
		expect(parseSpdx('(GPL-2.0+ WITH Classpath-exception-2.0)')).toEqual({ type: 'licence', id: 'GPL-2.0', plus: true, exception: 'Classpath-exception-2.0' });
		expect(spdxIds(parseSpdx('(MIT OR (Apache-2.0 AND LicenseRef-x))') ?? { type: 'licence', id: '', plus: false, exception: null })).toEqual(['MIT', 'Apache-2.0', 'LicenseRef-x']);
	});

	test.each(['', 'Apache 2', 'SEE LICENSE IN LICENSE.txt', 'MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT WITH', 'MIT and ISC', 'BSD*'])('rejects %j as an SPDX expression', text => {
		expect(parseSpdx(text)).toBeNull();
	});

	test.each([
		'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'CC0-1.0', '0BSD', 'BlueOak-1.0.0',
		'AGPL-3.0-or-later', 'GPL-3.0-only', 'LGPL-3.0-or-later', 'GPL-3.0+', 'LGPL-3.0',
		'Python-2.0', 'Unlicense', 'Zlib', 'CC-BY-4.0', '(MIT AND Zlib)', 'AFL-2.1 OR BSD-3-Clause', 'SSPL-1.0 AND MIT OR ISC', 'mit',
	])('allows %s', text => {
		expect(allowed(text)).toBe(true);
	});

	test.each([
		'SSPL-1.0', 'MIT AND SSPL-1.0', '(SSPL-1.0 OR CC-BY-NC-4.0)', 'GPL-2.0-only', 'GPL-2.0-or-later', 'MPL-2.0-no-copyleft-exception',
		'UNLICENSED', 'CC-BY-3.0', 'PSF-2.0', 'GPL-3.0-or-later WITH Classpath-exception-2.0', 'LicenseRef-Proprietary',
	])('denies %s', text => {
		expect(allowed(text)).toBe(false);
	});

	test('reads the license field as declared and the legacy forms as ADR-0009 A9 says', () => {
		expect(declaredLicence({ license: '(MIT OR CC0-1.0)' })).toEqual({ expression: '(MIT OR CC0-1.0)', legacy: null });
		expect(declaredLicence({ license: { type: 'ISC', url: 'x' } })).toEqual({ expression: 'ISC', legacy: 'license object' });
		expect(declaredLicence({ licenses: [{ type: 'MIT', url: 'x' }] })).toEqual({ expression: 'MIT', legacy: 'licenses array' });
		expect(declaredLicence({ licenses: ['MIT', { type: 'Apache-2.0' }] })).toEqual({ expression: '(MIT OR Apache-2.0)', legacy: 'licenses array' });
		expect(declaredLicence({ licenses: [{ type: 'MIT AND Zlib' }, 'ISC'] })).toEqual({ expression: '((MIT AND Zlib) OR ISC)', legacy: 'licenses array' });
		expect(declaredLicence({ licenses: [{ type: 'MIT' }, { url: 'x' }] })).toEqual({ expression: null, legacy: 'licenses array' });
		expect(declaredLicence({ licenses: [] })).toEqual({ expression: null, legacy: 'licenses array' });
		expect(declaredLicence({ license: null })).toEqual({ expression: null, legacy: 'license object' });
		expect(declaredLicence({ license: ' ' })).toEqual({ expression: null, legacy: null });
		expect(declaredLicence({})).toEqual({ expression: null, legacy: null });
		expect(declaredLicence({ license: 'MIT', licenses: [{ type: 'SSPL-1.0' }] })).toEqual({ expression: 'MIT', legacy: null });
	});
});
