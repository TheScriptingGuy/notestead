// CI run 39663284028, Diagnosis A (docs/test-plans/CI-M2-S2-x64-arm64.md, experiments E1 to E9): Chromium lays out the
// fields of <input type="datetime-local"> by the browser process's OS locale (LC_ALL, else LANG), not by the context's
// emulated `locale`. On the CI runner (C.UTF-8) the fields are in US order with a 12-hour clock, so the en-GB keys of
// AlarmDialog.enterLocal never completed a value. The harness launches Chromium in the en-GB locale of its contexts; these
// two checks guard that on every host. LOC-01: the en-GB keys give the value. LOC-02 (control): the US-order keys do not,
// so the spec can tell the two orders apart. No app code runs: a plain page in the webApp context.
import { expect, test } from '../support/fixtures.ts';

const wanted = '2026-10-21T22:04';
const field = '<input type="datetime-local" aria-label="When">';

test.describe('CI-M2S2 browser locale', () => {
	test('CI-M2S2-LOC-01 the date fields take the keys in en-GB order (dd/mm/yyyy, 24-hour clock) on any host locale', async ({ webApp }) => {
		const { page } = webApp;
		await page.setContent(field);
		const when = page.getByLabel('When');
		await when.pressSequentially('21102026');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.type('2204');
		await expect(when).toHaveValue(wanted);
	});

	test('CI-M2S2-LOC-02 control: the keys in US order (mm/dd/yyyy, 12-hour clock) do not give the value, so the two orders are told apart', async ({ webApp }) => {
		const { page } = webApp;
		await page.setContent(field);
		const when = page.getByLabel('When');
		await when.pressSequentially('10212026');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.type('1004P');
		expect(await when.inputValue()).not.toBe(wanted);
	});
});
