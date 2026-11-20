// A documented limitation (Q1 = (a), docs/test-plans/M2-S6.md RU-4): upstream's sync wizard draws its own Joplin Cloud logo as an
// inline SVG (upstream JoplinCloudIcon.tsx), not a file, so no static overlay can replace it and ADR-0010 records it as nominative
// use. This test pins that fact: if upstream changes the logo, the ADR-0010 limitation must be updated, never only the colours here.
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { JoplinWebApp } from '../support/pages/joplinWebApp.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import type { Locator } from '@playwright/test';

// The gradient stops of the logo at the pinned version.
const logoColours = ['#3873DB', '#163467'];

// The stop colours of every svg inside the locator, lowercased (the attribute, else the computed style).
const stopColours = (button: Locator): Promise<string[]> => button.evaluate(el => {
	interface Stop { getAttribute: (n: string) => string | null }
	const root = el as unknown as { querySelectorAll: (s: string) => ArrayLike<Stop> };
	return Array.from(root.querySelectorAll('svg stop'), stop => (stop.getAttribute('stop-color') ?? (globalThis as unknown as { getComputedStyle: (e: Stop) => { stopColor: string } }).getComputedStyle(stop).stopColor).toLowerCase());
});

test.describe('M2-S6 documented limitations', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-S6-LOGO-01 the sync wizard draws upstream\'s Joplin Cloud logo as an inline SVG, and nothing else there carries its gradient', async ({ stack, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		void webNetwork; // checks the network policy at the end of the test
		const app = new JoplinWebApp(webApp.page);
		await app.open(webApp.baseURL);
		const cloud = app.syncWizard().getByRole('button', { name: /^Joplin Cloud\b/ });
		const other = app.syncWizard().getByRole('button', { name: /^Other\b/ });
		await expect(cloud).toBeVisible();
		await expect(other).toBeVisible();
		const cloudStops = await stopColours(cloud);
		const otherStops = await stopColours(other);
		test.info().annotations.push({ type: 'logo', description: `Joplin Cloud button: ${JSON.stringify(cloudStops)}; Other button: ${JSON.stringify(otherStops)}` });
		if (cloudStops.length === 0) {
			test.info().annotations.push({ type: 'logo-aria', description: await cloud.ariaSnapshot() });
			test.info().annotations.push({ type: 'logo-html-length', description: String((await cloud.innerHTML()).length) });
		}
		for (const colour of logoColours) expect(cloudStops, `the Joplin Cloud button's svg gradient has the stop ${colour}`).toContain(colour.toLowerCase());
		// in-test control: the Other option has no such gradient
		for (const colour of logoColours) expect(otherStops, `the Other button has no stop ${colour}`).not.toContain(colour.toLowerCase());
	});
});
