// C1-R1 on a real DOM (review M1-S6a-r1 C1-R1; docs/test-plans/M1-S7.md): the "type like a user" helper refuses to
// type a registered secret into anything but an <input type="password">, and no key reaches the page when it refuses.
// The secret is a fresh synthetic value registered like any harness secret; the page is a local form (no app needed).
import { randomBytes } from 'node:crypto';
import { expect, test } from '../support/fixtures.ts';
import { SecretInVisibleFieldError, typeLikeUser } from '../support/typeLikeUser.ts';
import { registerSecrets } from '../../support/secrets.ts';

const form = '<main><form>'
	+ '<label>Visible <input type="text" name="visible"></label>'
	+ '<label>Notes <textarea name="notes"></textarea></label>'
	+ '<label>Masked <input type="password" name="masked"></label>'
	+ '</form></main>';

test.describe('C1-R1 type-like-a-user secret guard', () => {
	test('C1-R1-guard a registered secret is refused for a text input and a textarea, and typed into a password input', async ({ webApp }) => {
		const value = `nstsecret${randomBytes(12).toString('hex')}`;
		registerSecrets([{ label: 'c1r1_guard_secret', value }]);
		const { page } = webApp;
		await page.setContent(form);

		for (const name of ['Visible', 'Notes']) {
			const field = page.getByLabel(name);
			const refused = await typeLikeUser(field, value).then(() => undefined, (error: unknown) => error);
			expect(refused, `${name}: refused`).toBeInstanceOf(SecretInVisibleFieldError);
			await expect(field, `${name}: no key reached the field`).toHaveValue('');
		}

		// Positive control: the same helper and secret, into the masked field.
		const masked = page.getByLabel('Masked');
		await typeLikeUser(masked, value);
		expect(await masked.evaluate(e => (e as unknown as { value: string }).value.length)).toBe(value.length);
	});
});
