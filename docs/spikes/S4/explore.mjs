// S4 exploration: wait for the app to finish loading, then dump ARIA snapshot + screenshot.
// Usage: node explore.mjs <url> <outPrefix>
import fs from 'node:fs';
import { launch, attachLogging, WORK } from './lib.mjs';
const url = process.argv[2] ?? 'http://127.0.0.1:8080/';
const out = process.argv[3] ?? `${WORK}/explore`;
const logs = []; const t0 = Date.now();
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
attachLogging(page, logs);
await page.goto(url);
await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0, null, { timeout: 120000 });
await page.getByRole('progressbar', { name: 'Loading...' }).waitFor({ state: 'detached', timeout: 180000 }).catch(e => logs.push('still loading: ' + e.message));
console.log('ready after', Date.now() - t0, 'ms');
fs.writeFileSync(`${out}.aria.txt`, await page.locator('body').ariaSnapshot());
await page.screenshot({ path: `${out}.png` });
console.log(logs.filter(l => !l.includes('cached')).slice(-15).join('\n'));
await browser.close();
