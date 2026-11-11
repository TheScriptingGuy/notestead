// The image tags of the two test layers (tests/stack/imageTags.ts; docs/test-plans/M2-S3.md F10, CI-M2-S2 F-H1): the E2E stack
// builds and may keep one device image tag, and the contract layer must neither take that tag nor remove it at teardown.
import { describe, expect, test } from '@jest/globals';
import { webImageTag } from '../../contract/support/globalSetup.ts';
import { headlessTag } from '../../contract/support/headless.ts';
import { builtTags } from '../../stack/images.ts';
import { contractDeviceChoice, contractDeviceTag, stackDeviceTag } from '../../stack/imageTags.ts';

describe('image tags (F-H1)', () => {
	test('fh1-01 a device image named by NOTESTEAD_DEVICE_IMAGE is used as prebuilt, so a contract teardown never removes it', () => {
		expect(contractDeviceChoice('localhost/x:1')).toEqual({ image: 'localhost/x:1', prebuilt: true });
	});

	test('fh1-02 otherwise the contract layer builds its own tag, never the one the E2E run keeps', () => {
		expect(contractDeviceChoice(undefined)).toEqual({ image: contractDeviceTag, prebuilt: false });
		expect(contractDeviceChoice('')).toEqual({ image: contractDeviceTag, prebuilt: false });
		expect(contractDeviceTag).toBe('localhost/notestead-test-device:m1-s5-test');
		expect(stackDeviceTag('3.7.1')).toBe('localhost/notestead-test-device:3.7.1');
	});

	test('fh1-03 the tags the E2E stack builds and keeps and the tags the contract layer builds and removes never overlap', () => {
		const stack = [builtTags.web, builtTags.headless, stackDeviceTag('3.7.1')];
		const contract = [webImageTag, headlessTag, contractDeviceTag];
		expect(stack.filter(t => contract.includes(t))).toEqual([]);
	});
});
