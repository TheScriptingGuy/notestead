// M2-AC11 (docs/test-plans/M2-S6.md): the web container serves our branding to a real browser.
//   M2-AC11-01  the manifest name, <title> and every icon come from our overlay (browser, CDP manifest parser, served bytes)
//   M2-AC11-02  no served file equals one of upstream's icons or screenshots (the served-file scan, D7)
//   M2-AC11-03  NEG: the same checks, on the un-overlaid bundle served by the image under test on another port, report upstream's
//               branding, so the checks can see it (title Joplin, manifest Joplin Web, upstream's six icons and two screenshots)
// Expectations are constants (tests/support/branding.ts) or come from the commit the served bundle was built from (D6), never from
// overlay.json. Every spec starts the real app to its first screen on the origin it checks.
import { createHash } from 'node:crypto';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { brandingReport, fetchServed, openStaticPage, overlayIconsAt, scanServed, servedBundleCommit, staticPages } from '../support/branding.ts';
import type { BrandingReport } from '../support/branding.ts';
import { expect, test } from '../support/fixtures.ts';
import { JoplinWebApp } from '../support/pages/joplinWebApp.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { upstreamIconHashes, upstreamScreenshotHashes } from '../support/upstreamBranding.ts';
import { manifestIconRefs, productName, productShortName } from '../../support/branding.ts';
import type { BrowserContext, Page } from '@playwright/test';

const portOf = (url: string): number => Number.parseInt(new URL(url).port, 10);

// The browser's own parse of the page's manifest (Chrome DevTools Protocol Page.getAppManifest).
const browserManifest = async (app: { context: BrowserContext; page: Page }): Promise<{ url: string; errors: unknown[]; data?: string }> => {
	const cdp = await app.context.newCDPSession(app.page);
	return cdp.send('Page.getAppManifest');
};

const documentTitle = (page: Page): Promise<string> => page.title();

const shaOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

test.describe('M2-AC11 branding served to a browser', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('M2-AC11-01 the manifest name, the title and every icon come from our overlay', async ({ stack, webApp, webNetwork, unoverlaidDist }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		void webNetwork; // records the context and checks the network policy at the end of the test
		const commit = servedBundleCommit();
		const ourIcons = overlayIconsAt(commit);
		const app = new JoplinWebApp(webApp.page);
		await app.open(webApp.baseURL);

		// Browser: the title with the sync wizard showing, and again after closing it and opening Configuration.
		await expect.poll(() => documentTitle(webApp.page), { message: 'document.title with the sync wizard showing' }).toBe(productName);
		await app.closeSyncWizard();
		await app.openConfiguration();
		await expect.poll(() => documentTitle(webApp.page), { message: 'document.title on the Configuration screen' }).toBe(productName);

		// Browser: the manifest as Chromium parses it.
		const manifest = await browserManifest(webApp);
		expect(manifest.url).toBe(`${new URL(webApp.baseURL).origin}/manifest.json`);
		expect(manifest.errors, 'the browser\'s manifest parser reports no error').toEqual([]);
		expect(manifest.data, 'Page.getAppManifest returned the manifest text').toBeDefined();
		const parsed = JSON.parse(manifest.data ?? '{}') as Record<string, unknown>;
		expect(parsed.name).toBe(productName);
		expect(parsed.short_name).toBe(productShortName);
		expect('screenshots' in parsed, 'the manifest has no screenshots').toBe(false);
		const sizes = manifestIconRefs(parsed).filter(i => i.type === 'image/png').map(i => i.sizes);
		expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));

		// The two other pages' titles, in second pages of the same context while the app page stays open (RU-2).
		for (const which of ['closed', 'justOneClient'] as const) {
			const page = await openStaticPage(webApp.context, new URL(webApp.baseURL).origin, which);
			try {
				expect(await documentTitle(page), `${staticPages[which].path} title`).toContain(productName);
			} finally {
				await page.close();
			}
		}

		// Data: what the container serves, byte for byte.
		const report = await brandingReport({ port: portOf(webApp.baseURL), origin: new URL(webApp.baseURL).origin, servedDir: unoverlaidDist.served, ourIcons });
		expect(report.htmlProblems, 'titles and descriptions of the three pages').toEqual([]);
		expect(report.manifestProblems, 'the served manifest').toEqual([]);
		expect(report.iconProblems, 'every icon reference resolves to our overlay icon at the served bundle\'s commit').toEqual([]);
		expect(report.iconSetProblems, 'icons/ holds exactly our overlay icons').toEqual([]);
		expect(report.iconsChecked.length, 'the icon check is not vacuous: the pages and the manifest reference icons').toBeGreaterThanOrEqual(8);
		test.info().annotations.push({ type: 'icons', description: `${report.iconsChecked.length} references checked against ${commit.slice(0, 12)}` });
	});

	test('M2-AC11-02 no served file equals an upstream icon or screenshot', async ({ stack, webApp, webNetwork, unoverlaidDist }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		const app = new JoplinWebApp(webApp.page);
		await app.open(webApp.baseURL);
		await app.closeSyncWizard();
		for (const path of ['/closed.html', '/just-one-client.html?no-retry=1', '/source.html']) {
			const page = await webApp.context.newPage();
			try {
				await page.goto(new URL(path, webApp.baseURL).href);
			} finally {
				await page.close();
			}
		}
		const scan = await scanServed(portOf(webApp.baseURL), unoverlaidDist.served, webNetwork.entries().map(e => e.url), { icons: upstreamIconHashes(), screenshots: upstreamScreenshotHashes() });
		test.info().annotations.push({ type: 'scan', description: `${scan.entries.length} paths scanned (${scan.servedFiles} served files), statuses ${JSON.stringify(countBy(scan.entries.map(e => e.status)))}, ${scan.pngs} PNG` });
		expect(scan.iconHits, 'a served body equals one of upstream\'s six icons').toEqual([]);
		expect(scan.screenshotHits, 'a served body equals one of upstream\'s two screenshots').toEqual([]);
		expect(scan.entries.length, 'the scan fetched at least every served file').toBeGreaterThanOrEqual(scan.servedFiles);
		expect(scan.pngs, 'the scan is not vacuous: it saw PNG files').toBeGreaterThan(0);
	});

	test('M2-AC11-03 NEG the un-overlaid bundle shows upstream\'s branding to the same checks', async ({ stack, extraWebs, appContexts, unoverlaidDist }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		const commit = servedBundleCommit();
		const web = await extraWebs.start({ role: 'web-unoverlaid', mountDist: unoverlaidDist.unoverlaid });
		const origin = web.url;
		expect(new URL(origin).hostname, 'not localhost: upstream\'s dev mode would change the title').toBe('127.0.0.1');
		const webApp = await appContexts.open(origin, 'neg');
		await new JoplinWebApp(webApp.page).open(origin);

		expect(await documentTitle(webApp.page), 'upstream\'s title').toBe('Joplin');
		const manifest = await browserManifest(webApp);
		const parsed = JSON.parse(manifest.data ?? '{}') as Record<string, unknown>;
		expect(parsed.name, 'upstream\'s manifest name').toBe('Joplin Web');

		const report: BrandingReport = await brandingReport({ port: portOf(origin), origin, servedDir: unoverlaidDist.unoverlaid, ourIcons: overlayIconsAt(commit) });
		expect(report.htmlProblems.join('\n'), 'the title check sees "Joplin"').toMatch(/Joplin/);
		expect(report.manifestProblems.join('\n'), 'the manifest check sees "Joplin Web"').toMatch(/Joplin Web/);
		expect(report.iconProblems.length, 'the icon check finds icons that are not ours').toBeGreaterThan(0);
		expect(report.iconSetProblems.join('\n'), 'icons/ holds upstream\'s icon-large.png').toContain('icon-large.png');

		const scan = await scanServed(portOf(origin), unoverlaidDist.unoverlaid, webApp.network.entries().map(e => e.url), { icons: upstreamIconHashes(), screenshots: upstreamScreenshotHashes() });
		expect(new Set(scan.iconHits.map(h => h.upstreamPath)), 'the scan finds all six upstream icons by their hashes').toEqual(new Set(upstreamIconHashes().values()));
		expect(new Set(scan.screenshotHits.map(h => h.upstreamPath)), 'and both screenshots').toEqual(new Set(upstreamScreenshotHashes().values()));
		const served = await fetchServed(portOf(origin), '/icons/icon-192.png');
		expect(shaOf(served.body), 'the un-overlaid icon-192.png is not ours').not.toBe(shaOf(overlayIconsAt(commit).get('icon-192.png')!));
	});
});

const countBy = (values: number[]): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
	return out;
};
