// S4 exploration helper: load app, run steps from a JSON list, dump ARIA + screenshot.
// Each step: {"click":{"role":"button","name":"Other"}} | {"fill":{"label":"...","value":"..."}} | {"wait":ms} | {"press":"Enter"}
import fs from 'node:fs';
import { launch, attachLogging, WORK } from './lib.mjs';
const [url, out, stepsJson] = [process.argv[2], process.argv[3], process.argv[4] ?? '[]'];
const steps = JSON.parse(stepsJson);
const logs = [];
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
attachLogging(page, logs);
await page.goto(url);
await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0, null, { timeout: 120000 });
await page.getByRole('progressbar', { name: 'Loading...' }).waitFor({ state: 'detached', timeout: 180000 });
for (const s of steps) {
	if (s.click) await page.getByRole(s.click.role, { name: s.click.name, exact: !!s.click.exact }).first().click({ timeout: 30000 });
	if (s.fill) await page.getByLabel(s.fill.label, { exact: !!s.fill.exact }).first().fill(s.fill.value, { timeout: 30000 });
	if (s.press) await page.keyboard.press(s.press);
	if (s.wait) await page.waitForTimeout(s.wait); // exploration only (never in real tests)
}
fs.writeFileSync(`${out}.aria.txt`, await page.locator('body').ariaSnapshot());
await page.screenshot({ path: `${out}.png` });
console.log(logs.filter(l => /error|warn|sync|Sync|crypt/i.test(l) && !l.includes('cached')).slice(-12).join('\n'));
await browser.close();
