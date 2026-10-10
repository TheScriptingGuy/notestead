// M1-S6a C1 inner self-test (review M1-S6-r1 C1): a test that FAILS ON PURPOSE after planting the secrets that only
// exist for this test (the per-test account's password and E2EE master password, created by the `e2eeAccount` fixture
// in the worker, and the Data API token of this test's own `headlessService`) into every channel a report carries:
// - the Playwright trace: a login form typed like a user (fill and pressSequentially: action parameters, step titles,
//   DOM snapshots) and a console message from the page (also the attached browser console);
// - a test.step title (the JSON, JUnit and HTML reports and the trace);
// - the test's stdout and stderr (the live console of the run, and stdout/stderr in the JSON, JUnit and HTML reports);
// - error messages (soft and hard assertion failures: report errors, step errors, the console epilogue);
// - attachments with a body and with a path (the test's own file in its output dir).
// Run only by tests/contract/m1-s6a/c1-pertest-secrets.test.ts, which scans everything the run wrote
// (docs/test-plans/M1-S6a.md). The secrets go to $NST_SELFTEST_PLANTED, a 0600 file outside test-results/ that the
// outer test reads and removes (never an uploaded artifact).
import { writeFileSync } from 'node:fs';
import { expect, test } from '../../e2e/support/fixtures.ts';
import { dataApiToken } from '../../stack/stack.ts';

test('M1-S6a C1 plants per-test secrets in every channel and fails on purpose', async ({ e2eeAccount, headlessService, webApp }, testInfo) => {
	const plantedFile = process.env.NST_SELFTEST_PLANTED;
	if (!plantedFile) throw new Error('NST_SELFTEST_PLANTED is not set: this spec is run by tests/contract/m1-s6a/c1-pertest-secrets.test.ts only');
	const token = dataApiToken(headlessService.container) ?? '';
	expect(token.length, 'the per-test headless service has a Data API token').toBeGreaterThanOrEqual(16);
	writeFileSync(plantedFile, JSON.stringify({
		secrets: [
			{ label: 'pertest_account_password', value: e2eeAccount.password },
			{ label: 'pertest_master_password', value: e2eeAccount.masterPassword },
			{ label: 'pertest_data_api_token', value: token },
		],
	}), { mode: 0o600 });

	// The trace: what M1-S7 does when it unlocks E2EE in the web app.
	const { page } = webApp;
	await page.setContent('<main><form><label>Account password <input type="password" name="pw"></label><label>Master password <input type="password" name="mp"></label></form></main>');
	await page.getByLabel('Account password').fill(e2eeAccount.password);
	await test.step(`C1 planted step ${e2eeAccount.masterPassword}`, async () => {
		await page.getByLabel('Master password').pressSequentially(e2eeAccount.masterPassword);
	});
	await page.evaluate(t => console.warn(`C1 planted data api token ${t}`), token);

	// stdout and stderr.
	process.stdout.write(`C1 planted account password ${e2eeAccount.password}\n`);
	process.stdout.write(`C1 planted data api token ${token}\n`);
	process.stderr.write(`C1 planted master password ${e2eeAccount.masterPassword}\n`);

	// Attachments: a body, and a file the test wrote into its own output dir.
	await testInfo.attach('pertest-body.txt', { body: `C1 planted account password ${e2eeAccount.password}`, contentType: 'text/plain' });
	const file = testInfo.outputPath('pertest-file.txt');
	writeFileSync(file, `C1 planted master password ${e2eeAccount.masterPassword}\nC1 planted data api token ${token}\n`);
	await testInfo.attach('pertest-file.txt', { path: file, contentType: 'text/plain' });

	// Error messages: a soft failure carrying the token, then the hard one carrying the master password.
	expect.soft(`C1 planted data api token ${token}`, 'C1: this soft failure is deliberate').toBe('a passing test');
	expect(`C1 planted master password ${e2eeAccount.masterPassword}`, 'C1: this failure is deliberate').toBe('a passing test');
});
