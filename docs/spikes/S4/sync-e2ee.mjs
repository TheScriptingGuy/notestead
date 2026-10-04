// S4 §B: configure the upstream web app (served by our Caddy) to sync with the throwaway Joplin Server
// through the same-origin proxy, then unlock E2EE and check the seeded notes are visible decrypted.
// Usage: node sync-e2ee.mjs <origin> <outPrefix> <masterPassword>
import fs from 'node:fs';
import { launch, attachLogging, isolationReport, WORK } from './lib.mjs';
const origin = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? `${WORK}/sync`;
const mpw = process.argv[4];
const logs = []; const reqs = new Map(); const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
attachLogging(page, logs);
page.on('request', r => { const u = new URL(r.url()); const k = `${r.method()} ${u.origin}${u.pathname.replace(/[0-9a-f]{32}/g, ':id').replace(/\/items\/root:\/[^/]*:/, '/items/root:/…:')}`; reqs.set(k, (reqs.get(k) ?? 0) + 1); });
await page.goto(`${origin}/`);
await page.getByRole('progressbar', { name: 'Loading...' }).waitFor({ state: 'detached', timeout: 180000 });
lap('app loaded');
await page.getByRole('button', { name: 'Other Select' }).click();
await page.getByRole('button', { name: '(None)' }).click();
await page.getByRole('menuitem', { name: 'Joplin Server', exact: true }).click();
await page.getByRole('textbox', { name: 'Joplin Server URL' }).fill(`${origin}/joplin-server`);
await page.getByRole('textbox', { name: 'Joplin Server email' }).fill('user1@example.com');
await page.getByRole('textbox', { name: 'Joplin Server password' }).fill('111111');
await page.getByRole('button', { name: 'Check synchronisation configuration' }).click();
await page.getByText(/Success|Error|error/).first().waitFor({ timeout: 60000 });
lap(`check config: ${(await page.getByText(/Success|Error|error/).first().textContent()).slice(0, 120)}`);
const save = page.getByRole('button', { name: 'Save changes' });
if (await save.isEnabled()) await save.click(); else lap('Save changes disabled after check (settings already saved by the check)');
await page.getByRole('button', { name: 'Back' }).click();
lap('saved; waiting for sync + E2EE prompt');
// After the first sync the note list shows a "Press to set the decryption password." banner.
const banner = page.getByRole('button', { name: 'Press to set the decryption password.' });
await banner.waitFor({ timeout: 180000 });
lap('decryption-password banner shown');
await banner.click();
await page.waitForTimeout(2000); // spike-only
fs.writeFileSync(`${out}.pwscreen.aria.txt`, await page.locator('body').ariaSnapshot());
const pwBox = page.locator('input[type="password"]').first();
await pwBox.fill(mpw);
lap('password typed');
const candidates = [/^(OK|Save|Submit|Unlock|Done|Set password|Confirm)$/i];
let clicked = false;
for (const re of candidates) { const b = page.getByRole('button', { name: re }).first(); if (await b.isVisible().catch(() => false)) { await b.click(); clicked = true; lap(`clicked ${await b.getAttribute('aria-label')}`); break; } }
if (!clicked) { await page.keyboard.press('Enter'); lap('pressed Enter'); }
let unlocked = true;
await page.waitForTimeout(3000);
const back = page.getByRole('button', { name: 'Back' }); if (await back.isVisible().catch(() => false)) await back.click();
fs.writeFileSync(`${out}.after-sync.aria.txt`, await page.locator('body').ariaSnapshot());
await page.screenshot({ path: `${out}.after-sync.png` });
if (unlocked) {
	await page.getByText('Seed note alpha').first().waitFor({ timeout: 180000 }).then(() => lap('decrypted note title "Seed note alpha" visible'), e => lap('note not visible: ' + e.message.split('\n')[0]));
}
fs.writeFileSync(`${out}.final.aria.txt`, await page.locator('body').ariaSnapshot());
await page.screenshot({ path: `${out}.final.png` });
console.log(JSON.stringify(await isolationReport(page)));
console.log('requests:'); for (const [k, v] of [...reqs].sort()) if (!k.includes('.bundle.js') && !/\.(png|ttf|wasm|css|html|json)$/.test(k)) console.log(`  ${v}x ${k}`);
console.log(logs.filter(l => /error|Error|sync|Sync|crypt|master/i.test(l) && !l.includes('cached') && !l.includes('Performance')).slice(-25).join('\n'));
await browser.close();
