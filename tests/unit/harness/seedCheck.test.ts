// DNS1-AC4 (dev1-u1): the seed post-condition on the server's info.json (tests/stack/seedCheck.ts). The samples have
// the structure of a real info.json with all key material removed: ids and flags only.
import { describe, expect, test } from '@jest/globals';
import { checkSeededInfo } from '../../stack/seedCheck.ts';

const realShaped = {
	version: 3,
	e2ee: { value: true, updatedTime: 1_760_000_000_000 },
	activeMasterKeyId: { value: '0123456789abcdef0123456789abcdef', updatedTime: 1_760_000_000_000 },
	masterKeys: [{ id: '0123456789abcdef0123456789abcdef', hasBeenUsed: true }],
	appMinVersion: '3.0.0',
};

const text = (info: object): string => JSON.stringify(info);

describe('dev1-u1 checkSeededInfo', () => {
	test('a real-shaped info.json with a master key and E2EE on is accepted', () => {
		expect(checkSeededInfo(200, text(realShaped))).toBeUndefined();
	});

	test('a missing info.json (404) is rejected with a reason', () => {
		expect(checkSeededInfo(404, 'Not found')).toEqual(expect.stringContaining('404'));
	});

	test('text that is not JSON is rejected', () => {
		expect(checkSeededInfo(200, '<html>Bad Gateway</html>')).toEqual(expect.stringMatching(/JSON/i));
	});

	test('an empty masterKeys list is rejected', () => {
		expect(checkSeededInfo(200, text({ ...realShaped, masterKeys: [] }))).toEqual(expect.stringMatching(/master ?key/i));
	});

	test('a missing masterKeys property is rejected', () => {
		const without: Record<string, unknown> = { ...realShaped };
		delete without.masterKeys;
		expect(checkSeededInfo(200, text(without))).toEqual(expect.stringMatching(/master ?key/i));
	});

	test('e2ee.value false is rejected even with a master key', () => {
		expect(checkSeededInfo(200, text({ ...realShaped, e2ee: { value: false, updatedTime: 1 } }))).toEqual(expect.stringMatching(/e2ee/i));
	});
});
