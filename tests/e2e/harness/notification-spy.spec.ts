// The Notification spy of M2-AC5's NEG (docs/test-plans/M2-S2.md D6), proven on plain same-origin pages of the stack's web
// container (/manifest.json): no app code runs, so a count can only come from the test itself.
import type { Frame, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { installNotificationSpy, readNotificationSpy } from '../support/notificationSpy.ts';

type Globals = {
	Notification: { new (title: string): unknown; requestPermission: () => Promise<string> };
	ServiceWorkerRegistration: { prototype: { showNotification: (...args: unknown[]) => unknown } };
};

// What a page script (or the web app) could do: construct a Notification, ask for permission, show a service-worker one.
const useNotificationApis = async (where: Page | Frame): Promise<void> => {
	await where.evaluate(() => {
		const g = globalThis as unknown as Globals;
		void new g.Notification('nst-spy-test');
		void g.Notification.requestPermission();
		try {
			void g.ServiceWorkerRegistration.prototype.showNotification.call({}, 'x');
		} catch {
			// illegal invocation: the spy has counted the call before the native method refused it
		}
	});
};

const constructOne = async (where: Page | Frame): Promise<void> => {
	await where.evaluate(() => {
		const g = globalThis as unknown as Globals;
		void new g.Notification('nst-spy-test');
	});
};

test.describe('M2-S2 Notification spy', () => {
	test('M2-S2-SPY-01 counts Notification constructions, permission requests and service-worker notifications in the main frame', async ({ webApp }) => {
		await installNotificationSpy(webApp.context);
		await webApp.page.goto(new URL('/manifest.json', webApp.baseURL).href);
		const before = await readNotificationSpy(webApp.page);
		expect(before.main).toMatchObject({ installed: true, constructed: 0, requested: 0, shown: 0 });
		expect(before.main?.native, 'this Chromium has a native Notification (otherwise the spy proves nothing: report it)').toBe(true);
		await useNotificationApis(webApp.page);
		const after = await readNotificationSpy(webApp.page);
		expect(after.main).toMatchObject({ constructed: 1, requested: 1, shown: 1 });
	});

	test('M2-S2-SPY-02 a reload gives a new document id and fresh counters', async ({ webApp }) => {
		await installNotificationSpy(webApp.context);
		await webApp.page.goto(new URL('/manifest.json', webApp.baseURL).href);
		await constructOne(webApp.page);
		const first = (await readNotificationSpy(webApp.page)).main;
		expect(first?.constructed).toBe(1);
		await webApp.page.reload();
		const second = (await readNotificationSpy(webApp.page)).main;
		expect(second?.docId).not.toBe(first?.docId);
		expect(second?.constructed).toBe(0);
	});

	test('M2-S2-SPY-03 a same-origin iframe has its own spy and counts in the totals', async ({ webApp }) => {
		const { page } = webApp;
		await installNotificationSpy(webApp.context);
		await page.goto(new URL('/manifest.json', webApp.baseURL).href);
		await page.evaluate(() => {
			const doc = (globalThis as unknown as { document: { createElement: (tag: string) => { src: string }; body: { appendChild: (el: unknown) => void } } }).document;
			const frame = doc.createElement('iframe');
			frame.src = '/manifest.json';
			doc.body.appendChild(frame);
		});
		await expect.poll(async () => (await readNotificationSpy(page)).framesWithSpy, { timeout: 30_000, intervals: [200] }).toBe(2);
		const child = page.frames().find(f => f !== page.mainFrame());
		expect(child, 'the iframe is a frame of the page').toBeDefined();
		if (child) await constructOne(child);
		const reading = await readNotificationSpy(page);
		expect(reading.constructed).toBe(1);
		expect(reading.main?.constructed).toBe(0);
	});
});
