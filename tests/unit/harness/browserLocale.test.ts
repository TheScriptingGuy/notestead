// The locale of the browser process (tests/e2e/support/chromium.ts; docs/test-plans/CI-M2-S2-x64-arm64.md Decisions A):
// Chromium lays out date and time fields by the process's locale environment, not by the context's emulated locale, so
// the harness launches it with the same locale as its contexts.
import { describe, expect, test } from '@jest/globals';
import { browserLocale, browserLocaleEnv } from '../../e2e/support/chromium.ts';

describe('browser locale', () => {
	test('ci-loc-01 browserLocaleEnv keeps the other variables, drops undefined ones and pins the locale variables', () => {
		const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/x', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', LANGUAGE: 'C', GONE: undefined };
		const env = browserLocaleEnv(base);
		expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x', LC_ALL: 'en_GB.UTF-8', LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB:en' });
		expect(base.LC_ALL, 'the input is not changed').toBe('C.UTF-8');
		expect(Object.keys(env)).not.toContain('GONE');
	});

	test('ci-loc-02 the locale name is the context locale with an underscore', () => {
		expect(browserLocale).toBe('en-GB');
		expect(browserLocaleEnv({}).LANG).toBe(`${browserLocale.replace('-', '_')}.UTF-8`);
		expect(browserLocaleEnv({}).LC_ALL).toBe(browserLocaleEnv({}).LANG);
	});
});
