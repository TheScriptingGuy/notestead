// ADR-0010: the Source link never covers upstream's controls (docs/test-plans/M2-S6.md D8, I5; tests/e2e/support/placement.ts).
// The link is fixed in the bottom-left corner at the highest z-index. In five states of the app, on a narrow (390x844) and a wide
// (1280x800) viewport, no visible control (button, link, checkbox, switch, menu item, tab, combo box, radio) may have the link at
// the centre of its box or under a quarter or more of its area. A failure names each covered control, its state and the overlap.
// Text boxes and editors are not controls here: their overlap is an annotation. Geometry, never screenshots (C1-R1).
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import type { WebApp } from '../support/fixtures.ts';
import { JoplinWebApp } from '../support/pages/joplinWebApp.ts';
import { coveredControls } from '../support/placement.ts';
import type { Box, Control } from '../support/placement.ts';
import { holdsFor } from '../../support/poll.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import type { Frame, Page } from '@playwright/test';

const controlRoles = ['button', 'link', 'checkbox', 'switch', 'menuitem', 'tab', 'combobox', 'radio'] as const;

interface RawBox { x: number; y: number; width: number; height: number; name: string; isLink: boolean }

// The controls of one frame with their boxes in that frame's own coordinates.
const rawControls = (frame: Frame, role: string): Promise<RawBox[]> => frame.getByRole(role as 'button').evaluateAll(elements => elements.map(e => {
	const el = e as unknown as { getBoundingClientRect: () => { x: number; y: number; width: number; height: number }; getAttribute: (n: string) => string | null; textContent: string | null; matches: (s: string) => boolean };
	const r = el.getBoundingClientRect();
	const label = el.getAttribute('aria-label') ?? el.textContent ?? '';
	return { x: r.x, y: r.y, width: r.width, height: r.height, name: label.replace(/\s+/g, ' ').trim().slice(0, 60), isLink: el.matches('a[href$="source.html"]') };
}));

// A frame's offset in the page (0,0 for the top frame); an iframe is as large as its box, so adding the frame element's box is exact
// for the app's iframes (no CSS transform, border or padding).
const frameOffset = async (frame: Frame): Promise<{ x: number; y: number }> => {
	if (frame.parentFrame() === null) return { x: 0, y: 0 };
	const box = await (await frame.frameElement()).boundingBox();
	return box ? { x: box.x, y: box.y } : { x: Number.NaN, y: Number.NaN };
};

const centreHitsLink = (page: Page, x: number, y: number): Promise<boolean> => page.evaluate(([px, py]) => {
	const g = globalThis as unknown as { document: { elementFromPoint: (x: number, y: number) => { closest: (s: string) => unknown } | null } };
	return !!g.document.elementFromPoint(px, py)?.closest('a[href$="source.html"]');
}, [x, y]);

const collect = async (page: Page, roles: readonly string[]): Promise<Control[]> => {
	const controls: Control[] = [];
	for (const frame of page.frames()) {
		let offset: { x: number; y: number };
		try {
			offset = await frameOffset(frame);
		} catch {
			continue; // a frame that detached
		}
		for (const role of roles) {
			let raw: RawBox[];
			try {
				raw = await rawControls(frame, role);
			} catch {
				continue;
			}
			for (const r of raw) {
				if (!(r.width > 0 && r.height > 0)) continue;
				const box: Box = { x: r.x + offset.x, y: r.y + offset.y, width: r.width, height: r.height };
				controls.push({ role, name: r.name, box, centreHitsLink: await centreHitsLink(page, box.x + box.width / 2, box.y + box.height / 2), isSourceLink: r.isLink });
			}
		}
	}
	return controls;
};

const format = (c: Control, share: number): string => `${c.role} ${JSON.stringify(c.name)} at (${Math.round(c.box.x)},${Math.round(c.box.y)}) ${Math.round(c.box.width)}x${Math.round(c.box.height)}: centre under the link: ${c.centreHitsLink}, ${Math.round(share * 100)}% covered`;

// Mouse-wheel over (x, y) until the content stops moving: the lowest control's box is unchanged after two further steps and for 2 s.
const scrollToEnd = async (page: Page, at: { x: number; y: number }): Promise<void> => {
	const signature = async (): Promise<string> => {
		const controls = (await collect(page, ['button', 'link', 'checkbox'])).filter(c => !c.isSourceLink);
		const lowest = controls.reduce<Control | undefined>((a, c) => (!a || c.box.y > a.box.y ? c : a), undefined);
		return JSON.stringify([controls.length, lowest?.name, lowest?.box]);
	};
	await page.mouse.move(at.x, at.y);
	let previous = await signature();
	let unchanged = 0;
	for (let step = 0; step < 50 && unchanged < 2; step++) {
		await page.mouse.wheel(0, 600);
		await page.evaluate(() => new Promise<void>(resolve => {
			const g = globalThis as unknown as { requestAnimationFrame: (cb: () => void) => void };
			g.requestAnimationFrame(() => g.requestAnimationFrame(() => resolve()));
		}));
		const now = await signature();
		unchanged = now === previous ? unchanged + 1 : 0;
		previous = now;
	}
	const settled = previous;
	await holdsFor('the scrolled content to stay where it is', async () => ((await signature()) === settled ? undefined : 'the content moved'), { windowMs: 2_000, intervalMs: 500 });
};

// One state's covered controls, appended to `findings` (RU-3: every state is visited, one list is asserted at the end).
const check = async (app: WebApp, state: string, viewport: string, findings: string[]): Promise<void> => {
	const page = app.page;
	const linkBox = await page.getByRole('link', { name: /^Source\b/ }).boundingBox();
	expect(linkBox, `${viewport}, ${state}: the Source link has a box`).not.toBeNull();
	const link = linkBox as Box;
	const controls = await collect(page, controlRoles);
	expect(controls.length, `${viewport}, ${state}: the check saw controls (not vacuous)`).toBeGreaterThan(1);
	const covered = coveredControls(controls, link);
	const textboxes = coveredControls(await collect(page, ['textbox']), link);
	if (textboxes.length > 0) test.info().annotations.push({ type: 'textbox-overlap', description: `${viewport}, ${state}: ${textboxes.map(t => format(t.control, t.share)).join('; ')}` });
	test.info().annotations.push({ type: 'placement', description: `${viewport}, ${state}: ${controls.length} controls, link at ${Math.round(link.x)},${Math.round(link.y)} ${Math.round(link.width)}x${Math.round(link.height)}` });
	for (const c of covered) findings.push(`${viewport}, ${state}: ${format(c.control, c.share)}`);
};

const run = async (webApp: WebApp, viewport: { width: number; height: number }, label: string): Promise<void> => {
	const findings: string[] = [];
	await webApp.page.setViewportSize(viewport);
	const app = new JoplinWebApp(webApp.page);
	await app.open(webApp.baseURL);
	await app.closeSyncWizard();
	await expect(app.sidebarButton()).toBeVisible();
	const middle = { x: viewport.width / 2, y: viewport.height / 2 };

	// the note to open: created in the UI (a fresh profile's list holds no note we can name)
	const title = 'Placement check';
	const note = await app.newNote();
	await note.typeTitle(title);
	await note.typeBody('A note for the placement check.');
	await app.backToList();

	// (1) the main screen, the note list scrolled to its end
	await scrollToEnd(webApp.page, middle);
	await check(webApp, 'main screen, list scrolled to its end', label, findings);

	// (2) the side menu, scrolled to its end
	await app.openSidebar();
	await scrollToEnd(webApp.page, { x: Math.min(150, viewport.width / 2), y: viewport.height / 2 });
	await check(webApp, 'side menu, scrolled to its end', label, findings);
	await app.closeSidebar();

	// (3) a note in the viewer, (4) the same note in edit mode
	await app.openNote(title);
	await expect(note.editToggle()).toBeVisible();
	await check(webApp, 'note in the viewer', label, findings);
	await note.startEditing();
	await check(webApp, 'note in edit mode (editor toolbar shown)', label, findings);
	await app.backToList();

	// (5) Configuration, scrolled to its end
	await app.openConfiguration();
	await scrollToEnd(webApp.page, middle);
	await check(webApp, 'Configuration, scrolled to its end', label, findings);

	expect(findings, `controls the Source link covers, over all five states (${label})`).toEqual([]);
};

test.describe('ADR-0010 the Source link never covers upstream controls', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-S6-ADR10-01 on a narrow viewport (390x844)', async ({ stack, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		void webNetwork;
		await run(webApp, { width: 390, height: 844 }, 'narrow 390x844');
	});

	test('M2-S6-ADR10-02 on a wide viewport (1280x800)', async ({ stack, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		void webNetwork;
		await run(webApp, { width: 1280, height: 800 }, 'wide 1280x800');
	});
});
