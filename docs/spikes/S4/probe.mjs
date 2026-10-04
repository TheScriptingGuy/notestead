// S4 probe: load the web bundle, report cross-origin isolation / OPFS / SW, dump an ARIA snapshot + screenshot.
// Usage: node probe.mjs <url> <outPrefix>
import fs from 'node:fs';
import { launch, attachLogging, isolationReport, WORK } from './lib.mjs';
const url = process.argv[2] ?? 'http://127.0.0.1:8080/';
const out = process.argv[3] ?? `${WORK}/probe`;
const logs = [];
const t0 = Date.now();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
attachLogging(page, logs);
await page.goto(url, { waitUntil: 'load' });
// The coi service worker may reload the page once; wait until the app root has content.
await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0, null, { timeout: 120000 });
await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
const loadMs = Date.now() - t0;
const iso = await isolationReport(page);
const snap = await page.locator('body').ariaSnapshot().catch(e => `ariaSnapshot failed: ${e}`);
fs.writeFileSync(`${out}.aria.txt`, snap);
await page.screenshot({ path: `${out}.png` });
console.log(JSON.stringify({ url, loadMs, ...iso }, null, 1));
console.log(logs.filter(l => !l.includes('Service worker: cached')).slice(0, 40).join('\n'));
await browser.close();
