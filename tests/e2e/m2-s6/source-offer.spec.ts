// M2-AC12 (docs/test-plans/M2-S6.md): AGPL-3.0 section 13, the source offer, is served and reachable.
//   M2-AC12-01  /source.html is linked from a keyboard-reachable Source link with an accessible name, on the main screen, closed.html
//               and just-one-client.html; each page declares <link rel="license"> to it
//   M2-AC12-02  source.html names upstream's repository and exact commit, ours and its exact commit, and the licences, all linked;
//               its relative links resolve through the container; our commit is a commit of this repository
//   M2-AC12-03  NEG: the un-overlaid bundle has no Source link, no rel=license and no /source.html
// External links are checked for shape only, never fetched.
import { spawnSync } from 'node:child_process';
import { request } from '../../contract/support/http.ts';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { openStaticPage, servedBundleCommit, staticPages } from '../support/branding.ts';
import { expect, test } from '../support/fixtures.ts';
import { JoplinWebApp } from '../support/pages/joplinWebApp.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { ourRepoUrl } from '../../support/branding.ts';
import { findRepoRoot, readVersionPin } from '../../support/repoRoot.ts';
import type { Locator, Page } from '@playwright/test';

const maxTabs = 200;
const portOf = (url: string): number => Number.parseInt(new URL(url).port, 10);

// The one element the AC is about: the Source link, found by role and accessible name (never a class).
const sourceLink = (page: Page): Locator => page.getByRole('link', { name: /^Source\b/ });

// <link rel="license"> of the page, resolved by the browser (it is not in the accessibility tree).
const licenseLinkHref = (page: Page): Promise<string | undefined> => page.evaluate(() => {
	const g = globalThis as unknown as { document: { querySelector: (s: string) => { href?: string } | null } };
	return g.document.querySelector('link[rel~="license"]')?.href;
});

const isFocused = (page: Page): Promise<boolean> => sourceLink(page).evaluate(el => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement);

// Tab from the page's initial focus until the Source link has it; the count of presses.
const tabsToLink = async (page: Page): Promise<number> => {
	for (let presses = 1; presses <= maxTabs; presses++) {
		await page.keyboard.press('Tab');
		if (await isFocused(page)) return presses;
	}
	throw new Error(`the Source link did not take the focus within ${maxTabs} Tab presses`);
};

const checkLink = async (page: Page, label: string): Promise<void> => {
	const origin = new URL(page.url()).origin;
	const link = sourceLink(page);
	await expect(link, `${label}: exactly one link named Source`).toHaveCount(1);
	await expect(link, `${label}: visible`).toBeVisible();
	await expect(link, `${label}: in the viewport`).toBeInViewport();
	// Label in name (WCAG 2.5.3): the accessible name contains the visible text.
	const visibleText = (await link.innerText()).trim();
	expect(visibleText).toBe('Source');
	const snapshot = await link.ariaSnapshot();
	const name = /^- link "([^"]+)"/.exec(snapshot)?.[1];
	expect(name, `${label}: the link's accessible name (aria snapshot: ${snapshot})`).toContain(visibleText);
	expect(await link.evaluate(el => (el as unknown as { href: string }).href), `${label}: href`).toBe(`${origin}/source.html`);
	expect(await licenseLinkHref(page), `${label}: <link rel="license">`).toBe(`${origin}/source.html`);
};

test.describe('M2-AC12 the source offer', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC12-01 /source.html is linked from a keyboard-reachable Source link with an accessible name', async ({ stack, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		void webNetwork; // checks the network policy at the end of the test
		const tabs: Record<string, number> = {};
		const origin = new URL(webApp.baseURL).origin;

		// RU-2: the app page first, kept open; the static pages in second pages of the same context
		const app = new JoplinWebApp(webApp.page);
		await app.open(webApp.baseURL);
		await app.closeSyncWizard();
		await expect(app.sidebarButton()).toBeVisible();

		for (const which of ['closed', 'justOneClient'] as const) {
			const path = staticPages[which].path;
			const page = await openStaticPage(webApp.context, origin, which);
			try {
				await checkLink(page, path);
				tabs[path] = await tabsToLink(page);
				await expect(sourceLink(page)).toBeFocused();
				await page.keyboard.press('Enter');
				await page.waitForURL('**/source.html');
				await expect(page.getByRole('heading', { name: /^Source code of /, level: 1 })).toBeVisible();
			} finally {
				await page.close();
			}
		}

		// the main screen's own checks, Enter last
		await checkLink(webApp.page, 'the main screen');
		tabs['main screen'] = await tabsToLink(webApp.page);
		await expect(sourceLink(webApp.page)).toBeFocused();
		test.info().annotations.push({ type: 'tabs', description: JSON.stringify(tabs) });
		await webApp.page.keyboard.press('Enter');
		await webApp.page.waitForURL('**/source.html');
		await expect(webApp.page.getByRole('heading', { name: /^Source code of /, level: 1 })).toBeVisible();
	});

	test('M2-AC12-02 source.html names upstream and our repository at their exact commits and links the licences', async ({ stack, webApp }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		const { web } = readVersionPin();
		const upstream = web.repo.replace(/\.git$/, '').replace(/\/+$/, '');
		const commit = servedBundleCommit();
		const ours = ourRepoUrl();
		const origin = new URL(webApp.baseURL).origin;

		await webApp.page.goto(`${origin}/source.html`);
		const links = await webApp.page.getByRole('link').evaluateAll(anchors => anchors.map(a => {
			const el = a as unknown as { href: string; textContent: string | null; getAttribute: (n: string) => string | null };
			return { href: el.href, raw: el.getAttribute('href') ?? '', text: (el.textContent ?? '').trim() };
		}));
		const find = (href: string): { href: string; raw: string; text: string } | undefined => links.find(l => l.href === href);
		const body = await webApp.page.locator('body').innerText();

		expect(find(upstream), `a link to upstream's repository ${upstream}`).toBeDefined();
		expect(find(`${upstream}/tree/${web.commit}`)?.text, 'upstream\'s exact commit, linked, with the full hash as its text').toBe(web.commit);
		expect(body, 'the upstream release tag').toContain(web.tag);
		expect(find(ours), `a link to our repository ${ours}`).toBeDefined();
		expect(find(`${ours}/tree/${commit}`)?.text, `our exact commit (the served bundle's: ${commit}), linked, with the full hash as its text`).toBe(commit);
		expect(find(`${upstream}/blob/${web.commit}/LICENSE`), 'upstream\'s licence file at its commit').toBeDefined();
		expect(find(`${ours}/blob/${commit}/LICENSE`), 'our licence file at our commit').toBeDefined();
		expect(find('https://www.gnu.org/licenses/agpl-3.0.html'), 'the GNU AGPL-3.0 text').toBeDefined();

		// Relative links resolve through the container; the notices file is plain text and names the licence.
		const relative = links.filter(l => new URL(l.href).origin === origin);
		expect(relative.length, 'source.html links to files of the bundle').toBeGreaterThan(0);
		for (const l of relative) {
			const res = await request({ port: portOf(webApp.baseURL), path: new URL(l.href).pathname });
			expect(res.status, `${l.raw} (${l.href}) answers 200`).toBe(200);
		}
		const notices = await request({ port: portOf(webApp.baseURL), path: '/third-party-notices.txt' });
		expect(notices.status).toBe(200);
		expect(String(notices.headers['content-type'])).toMatch(/^text\/plain/);
		expect(notices.body.length).toBeGreaterThan(0);
		expect(notices.text).toContain('AGPL-3.0-or-later');

		// Git: the commit named on the page is a commit of this repository, and is in HEAD's history.
		const root = findRepoRoot();
		expect(spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root }).status, `${commit} is a commit of this repository`).toBe(0);
		expect(spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root }).status, `${commit} is an ancestor of HEAD`).toBe(0);
	});

	test('M2-AC12-03 NEG the un-overlaid bundle has no Source link, no licence link and no source.html', async ({ stack, extraWebs, appContexts, unoverlaidDist }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		const web = await extraWebs.start({ role: 'web-unoverlaid', mountDist: unoverlaidDist.unoverlaid });
		const origin = web.url;

		// RU-2: the app first and kept open, then the two static pages in second pages of the same context
		const app = await appContexts.open(origin, 'neg');
		const joplin = new JoplinWebApp(app.page);
		await joplin.open(origin);
		await joplin.closeSyncWizard();
		await expect(joplin.sidebarButton()).toBeVisible();
		for (const which of ['closed', 'justOneClient'] as const) {
			const path = staticPages[which].path;
			const page = await openStaticPage(app.context, origin, which);
			try {
				await expect(sourceLink(page), `${path}: no link named Source`).toHaveCount(0);
				expect(await licenseLinkHref(page), `${path}: no <link rel="license">`).toBeUndefined();
			} finally {
				await page.close();
			}
		}
		await expect(sourceLink(app.page), 'main screen: no link named Source').toHaveCount(0);
		expect(await licenseLinkHref(app.page), 'main screen: no <link rel="license">').toBeUndefined();

		expect((await request({ port: portOf(origin), path: '/source.html' })).status, '/source.html').toBe(404);
	});
});
