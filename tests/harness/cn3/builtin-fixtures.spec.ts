// Inner specs of the C-N3 proof (tests/integration/harness/cn3-builtin-fixtures.test.ts): two of them ask for
// Playwright's built-in fixtures and must fail; the control asks for neither and must pass.
import { expect, test } from '../../e2e/support/fixtures.ts';

test('C-N3 inner page', async ({ page }) => {
	expect(page).toBeTruthy();
});

test('C-N3 inner context', async ({ context }) => {
	expect(context).toBeTruthy();
});

test('C-N3 inner control', async ({ browserName }) => {
	expect(browserName).toBe('chromium');
});
