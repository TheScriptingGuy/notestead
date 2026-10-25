// Which Chromium Playwright launches (docs/test-plans/M1-S6.md §Chromium; ADR-0007 "Where things run").
// - CI: the browser of the pinned Playwright (the official Playwright container image, or `playwright install`).
// - NOTESTEAD_CHROMIUM=<path>: that executable.
// - Locally: Playwright's own revision when it is installed; otherwise the newest installed `chromium-<rev>` in the
//   browser cache, passed as executablePath (spike S4 proved r1223 works with Playwright 1.59.1, which expects r1217).
//   No browser is ever downloaded by the harness.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from '../../support/repoRoot.ts';

export interface ChromiumChoice {
	executablePath?: string;
	expectedRevision?: string;
	note: string;
}

const cacheDir = (): string => process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');

const executableIn = (dir: string): string | undefined => {
	for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
		if (existsSync(join(dir, rel))) return join(dir, rel);
	}
	return undefined;
};

// The locale of the web app's browser contexts and of the browser process. Chromium lays out the fields of date and time
// inputs by the browser process's locale environment (LC_ALL, else LANG), not by the context's emulated `locale`; `--lang`
// does nothing on Linux (docs/test-plans/CI-M2-S2-x64-arm64.md, experiments E1 to E9). A runner on C.UTF-8 therefore got US
// order with a 12-hour clock under an en-GB context. The harness launches Chromium in the contexts' locale, as a real
// en-GB user's browser has: `browserLocale` for `newContext`, `browserLocaleEnv` for `launch({ env })`.
export const browserLocale = 'en-GB';

export const browserLocaleEnv = (base: NodeJS.ProcessEnv): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== undefined) env[name] = value;
	}
	const name = `${browserLocale.replace('-', '_')}.UTF-8`;
	env.LC_ALL = name;
	env.LANG = name;
	env.LANGUAGE = `${browserLocale.replace('-', '_')}:${browserLocale.split('-')[0]}`;
	return env;
};

export const chooseChromium = (): ChromiumChoice => {
	if (process.env.NOTESTEAD_CHROMIUM) return { executablePath: process.env.NOTESTEAD_CHROMIUM, note: 'NOTESTEAD_CHROMIUM' };
	if (process.env.CI) return { note: 'CI: the pinned Playwright browser' };
	let expectedRevision: string | undefined;
	try {
		const browsers = JSON.parse(readFileSync(join(findRepoRoot(), 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
		expectedRevision = browsers.browsers.find(b => b.name === 'chromium')?.revision;
	} catch {
		return { note: 'playwright-core not installed' };
	}
	const cache = cacheDir();
	if (expectedRevision && executableIn(join(cache, `chromium-${expectedRevision}`))) return { expectedRevision, note: `Playwright's chromium-${expectedRevision}` };
	let installed: string[] = [];
	try {
		installed = readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
	} catch {
		// no cache
	}
	for (const dir of installed) {
		const exe = executableIn(join(cache, dir));
		if (exe) return { executablePath: exe, expectedRevision, note: `${dir} instead of chromium-${expectedRevision} (no browser download; spike S4)` };
	}
	return { expectedRevision, note: `no Chromium installed in ${cache}: run \`corepack yarn playwright install chromium\` (needs the user's approval on the Pi)` };
};
