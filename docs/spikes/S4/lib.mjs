// Shared helpers for spike S4 browser scripts (spike-only code).
// playwright-core is installed in ~/joplin-web-app-work/spikes/S4 (not in the repo).
import { createRequire } from 'node:module';
import os from 'node:os';
const work = process.env.S4_WORK ?? `${os.homedir()}/joplin-web-app-work/spikes/S4`;
const require = createRequire(`${work}/package.json`);
export const { chromium } = require('playwright-core');
export const WORK = work;
// The Pi has Playwright's chromium-1223 installed; pass it explicitly (playwright-core 1.59.1 expects 1217).
export const CHROME = process.env.CHROME ?? `${os.homedir()}/.cache/ms-playwright/chromium-1223/chrome-linux/chrome`;

export async function launch() {
	return chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
}

export function attachLogging(page, sink) {
	page.on('console', m => sink.push(`[console.${m.type()}] ${m.text()}`.slice(0, 400)));
	page.on('pageerror', e => sink.push(`[pageerror] ${String(e).slice(0, 400)}`));
	page.on('requestfailed', r => sink.push(`[requestfailed] ${r.method()} ${r.url().replace(/token=[^&]+/, 'token=REDACTED')} ${r.failure()?.errorText}`));
}

export async function isolationReport(page) {
	return page.evaluate(async () => {
		const out = { crossOriginIsolated: self.crossOriginIsolated, secureContext: self.isSecureContext, sw: !!navigator.serviceWorker?.controller };
		try { const d = await navigator.storage.getDirectory(); out.opfs = !!d; const names = []; for await (const [n] of d.entries()) names.push(n); out.opfsEntries = names; } catch (e) { out.opfs = String(e); }
		try { out.storageEstimate = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
		out.dev = self.__DEV__;
		return out;
	});
}
