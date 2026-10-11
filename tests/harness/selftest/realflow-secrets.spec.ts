// M1-S7 C1-R1 inner self-test (review M1-S6a-r1 C1-R1; docs/test-plans/M1-S7.md): the real login and E2EE-unlock flow
// of the walking skeleton (M1-AC21 steps 3 and 4, the same code: tests/e2e/support/flows.ts) against the real web
// bundle, ending on the sync settings screen with the account password in its field, then a deliberate failure, so
// Playwright keeps the trace (network bodies: the login POST carries the account password, its response the session
// id) and writes error-context.md (an ARIA snapshot of that screen, field values included).
// Run only by tests/contract/m1-s7/c1r1-realflow-secrets.test.ts, which scans everything the run wrote. The planted
// values go to $NST_SELFTEST_PLANTED (0600, outside test-results/), which the outer test reads and removes.
import { writeFileSync } from 'node:fs';
import { expect, test } from '../../e2e/support/fixtures.ts';
import { configureJoplinServerSync, firstSyncTimeoutMs, unlockE2ee } from '../../e2e/support/flows.ts';
import { JoplinWebApp } from '../../e2e/support/pages/joplinWebApp.ts';

test('M1-S7 C1-R1 the real login and unlock flow, then a deliberate failure', async ({ joplinServer, e2eeAccount, webApp }) => {
	const plantedFile = process.env.NST_SELFTEST_PLANTED;
	if (!plantedFile) throw new Error('NST_SELFTEST_PLANTED is not set: this spec is run by tests/contract/m1-s7/c1r1-realflow-secrets.test.ts only');
	const seeded = e2eeAccount.notes?.[0];
	if (!seeded) throw new Error('the e2eeAccount fixture seeded no note');

	// The session ids the browser sends (X-API-AUTH): credentials too, but no registry knows them. Also every id a
	// POST …/api/sessions response returns, sent later or not (M1-S8 C1-R1b): collected here independently of the
	// redacting reporter, so the scan's oracle does not share the reporter's blind spots.
	const sessions = new Set<string>();
	const bodies: Promise<void>[] = [];
	webApp.page.on('request', r => {
		const id = r.headers()['x-api-auth'];
		if (id) sessions.add(id);
	});
	webApp.page.on('response', r => {
		if (r.request().method() !== 'POST' || !new URL(r.url()).pathname.endsWith('/api/sessions')) return;
		bodies.push(r.json().then((b: unknown) => {
			const id = (b as { id?: unknown } | null)?.id;
			if (typeof id === 'string' && id !== '') sessions.add(id);
		}, () => undefined));
	});
	const plant = (reached: string): void => writeFileSync(plantedFile, JSON.stringify({
		reached,
		secrets: [
			{ label: 'pertest_account_password', value: e2eeAccount.password },
			{ label: 'pertest_master_password', value: e2eeAccount.masterPassword },
			...[...sessions].map((value, i) => ({ label: `session_id_${i}`, value })),
		],
	}), { mode: 0o600 });
	plant('start');

	const app = new JoplinWebApp(webApp.page);
	await configureJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
	await expect(app.decryptionBanner()).toBeVisible({ timeout: firstSyncTimeoutMs });
	await unlockE2ee(app, e2eeAccount);
	await expect.poll(() => app.noteInList(seeded.title).isVisible(), { timeout: 3 * 60_000, intervals: [1_000] }).toBe(true);
	await Promise.all(bodies);
	plant('note visible');

	// The sync settings again: the password field holds the account password (masked on screen, a value in the DOM).
	await app.openSidebar();
	await webApp.page.getByRole('button', { name: 'Configuration', exact: true }).click();
	await webApp.page.getByRole('tab', { name: /^Synchronisation\b/ }).click();
	await expect(webApp.page.getByLabel('Joplin Server password', { exact: true })).toHaveAttribute('type', 'password');
	await Promise.all(bodies);
	plant('settings shown');

	expect('the real flow ran', 'C1-R1: this failure is deliberate').toBe('a passing test');
});
