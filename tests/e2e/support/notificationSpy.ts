// A spy on the web notification APIs for M2-AC5's NEG (docs/test-plans/M2-S2.md D6; limitation L1). Installed as a
// context init script, it runs in every frame before any page script and counts new Notification(…),
// Notification.requestPermission(…) and ServiceWorkerRegistration.prototype.showNotification(…). Each document gets a
// random docId, so a reload (which resets the counts) is detected. Notifications a service worker shows from its own
// scope are out of its reach; upstream's service worker shows none.
import type { BrowserContext, Page } from '@playwright/test';

export interface SpyState { installed: true; native: boolean; docId: string; constructed: number; requested: number; shown: number }
export interface SpyReading { main?: SpyState; frames: number; framesWithSpy: number; constructed: number; requested: number; shown: number }

// Runs inside the page: no closure over anything in this file.
const spy = (): void => {
	const g = globalThis as unknown as Record<string, unknown>;
	if (g.__nstNotifications) return;
	type NotificationCtor = (new (...args: unknown[]) => object) & { permission?: string; requestPermission?: (...args: unknown[]) => unknown; prototype: object };
	const original = g.Notification as NotificationCtor | undefined;
	const state = { installed: true, native: typeof original === 'function', docId: `${Date.now()}-${Math.random().toString(16).slice(2)}`, constructed: 0, requested: 0, shown: 0 };
	Object.defineProperty(g, '__nstNotifications', { value: state });
	const Spy = function(this: unknown, ...args: unknown[]): object {
		state.constructed++;
		return original ? Reflect.construct(original, args, new.target ?? Spy) as object : {};
	} as unknown as NotificationCtor;
	Spy.prototype = original?.prototype ?? {};
	Object.defineProperty(Spy, 'permission', { get: () => original?.permission ?? 'denied' });
	Spy.requestPermission = (...args: unknown[]) => {
		state.requested++;
		return original?.requestPermission?.(...args) ?? Promise.resolve('denied');
	};
	g.Notification = Spy;
	const registration = g.ServiceWorkerRegistration as { prototype: { showNotification?: (...args: unknown[]) => unknown } } | undefined;
	const show = registration?.prototype.showNotification;
	if (registration && show) {
		registration.prototype.showNotification = function(this: unknown, ...args: unknown[]) {
			state.shown++;
			return show.apply(this, args);
		};
	}
};

export const installNotificationSpy = async (context: BrowserContext): Promise<void> => {
	await context.addInitScript(spy);
};

// The spy of every frame of the page (a frame that detached while it was read counts as one without a spy).
export const readNotificationSpy = async (page: Page): Promise<SpyReading> => {
	const frames = page.frames();
	const states = await Promise.all(frames.map(async (frame): Promise<SpyState | undefined> => {
		try {
			return await frame.evaluate(() => (globalThis as unknown as { __nstNotifications?: SpyState }).__nstNotifications);
		} catch {
			return undefined;
		}
	}));
	const present = states.filter((s): s is SpyState => s !== undefined);
	return {
		main: states[frames.indexOf(page.mainFrame())],
		frames: frames.length,
		framesWithSpy: present.length,
		constructed: present.reduce((n, s) => n + s.constructed, 0),
		requested: present.reduce((n, s) => n + s.requested, 0),
		shown: present.reduce((n, s) => n + s.shown, 0),
	};
};
