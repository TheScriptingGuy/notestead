// M2-S4 / M2-AC9 NEG 2 (docs/test-plans/M2-S4.md P4, D7): a plugin whose manifest says platforms: ["desktop"] is uploaded in the
// web app. Upstream installs it and marks it "Incompatible", and never runs it (the AC allows "refused or marked incompatible").
// Its mobile twin (platforms: ["desktop", "mobile"]), installed the same way, runs: that is the positive control. Both are built
// per test from tests/fixtures/plugins/probe/ with our own ustar writer, and on start each creates one note titled with its own
// marker, which the headless REST API sees after a sync cycle. Needs NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { notesTitled } from '../support/dataApi.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp, syncWebThenHeadless } from '../support/flows.ts';
import { endOfTestViolations } from '../support/network.ts';
import { localFilesNamed } from '../support/localProfile.ts';
import { JoplinWebApp, appStartTimeoutMs } from '../support/pages/joplinWebApp.ts';
import { buildProbeJpl } from '../support/pluginProbe.ts';
import { attachPluginConsole, enablePluginSupport, installPluginFromFile, pluginRepositoryPrefixes, pluginRepoActivity } from '../support/plugins.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';

const incompatibleText = 'This plugin doesn\'t support Joplin Mobile.';

test.describe('M2-S4 plugin platforms', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test.afterEach(async ({ webApp }, testInfo) => {
		await attachPluginConsole(webApp, testInfo);
	});

	test('M2-AC9-03 (NEG 2) a platforms: ["desktop"] plugin uploaded on web installs but is marked Incompatible and never runs, while its mobile twin runs', async ({ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S4');
		for (const prefix of pluginRepositoryPrefixes) webNetwork.allow(prefix);
		const app = new JoplinWebApp(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const dir = mkdtempSync(join(tmpdir(), 'nst-probe-'));
		try {
			const run = randomBytes(4).toString('hex');
			const desktop = buildProbeJpl({ kind: 'desktop', run, dir });
			const mobile = buildProbeJpl({ kind: 'mobile', run, dir });
			const markerCount = (marker: string): number => notesTitled(dataApi, marker, { includeDeleted: true }).length;
			const cycle = async (label: string): Promise<void> => {
				const { webMs, headlessMs } = await syncWebThenHeadless(app, webNetwork, stack, headlessService);
				test.info().annotations.push({ type: 'cycle', description: `${label}: web ${webMs} ms, headless ${headlessMs} ms` });
			};
			// Up to three cycles, each followed by one REST read, until the marker count satisfies `done`.
			const cycleUntil = async (label: string, marker: string, done: (n: number) => boolean): Promise<number> => {
				let n = markerCount(marker);
				for (let i = 1; i <= 3 && !done(n); i++) {
					await cycle(`${label} ${i}`);
					n = markerCount(marker);
				}
				return n;
			};

			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			let plugins = await enablePluginSupport(app);

			await test.step('1. install the desktop-only plugin: installed, marked Incompatible, with upstream\'s message', async () => {
				await installPluginFromFile(plugins, desktop.path);
				await expect(plugins.installedHeading(1)).toBeVisible();
				expect(await plugins.chips(desktop.name)).toContain('Incompatible');
				expect(await plugins.incompatibleMessage(desktop.name)).toBe(incompatibleText);
			});

			await test.step('2. install its mobile twin: installed, not Incompatible', async () => {
				await installPluginFromFile(plugins, mobile.path);
				await expect(plugins.installedHeading(2)).toBeVisible();
				expect(await plugins.chips(mobile.name)).not.toContain('Incompatible');
			});

			let before = 0;
			await test.step('3. the twin\'s marker note reaches REST, the desktop-only plugin\'s never does', async () => {
				await app.backToList();
				before = await cycleUntil('twin marker', mobile.marker, n => n >= 1);
				expect(before, 'positive control: the mobile twin ran and created its marker note').toBeGreaterThanOrEqual(1);
				expect(markerCount(desktop.marker), 'the desktop-only plugin never ran').toBe(0);
			});

			await test.step('4. reload: the desktop-only card still shows Incompatible', async () => {
				await webApp.page.reload();
				await app.sidebarButton().waitFor({ timeout: appStartTimeoutMs });
				plugins = await (await app.openConfiguration()).openSection('Plugins');
				await expect(plugins.installedHeading(2)).toBeVisible();
				expect(await plugins.chips(desktop.name)).toContain('Incompatible');
				await app.backToList();
			});

			await test.step('5. after the reload the twin runs again and the desktop-only plugin still does not', async () => {
				const after = await cycleUntil('after reload', mobile.marker, n => n > before);
				expect(after, 'the twin ran again after the reload').toBeGreaterThan(before);
				expect(markerCount(desktop.marker), 'the desktop-only plugin never ran').toBe(0);
			});

			await test.step('6. OPFS: the desktop-only .jpl is stored, not run', async () => {
				const files = await localFilesNamed(webApp, `${desktop.id}.jpl`);
				expect(files).toHaveLength(1);
				expect(files[0].sha256).toBe(desktop.sha256);
				test.info().annotations.push({ type: 'neg2', description: 'desktop-only stored, not run' });
			});

			await test.step('7. network policy', async () => {
				expect(endOfTestViolations(webNetwork.entries(), origin, webNetwork.allowed()), 'cross-origin requests outside the plugin repository').toEqual([]);
				expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => `${e.method} ${new URL(e.url).pathname}`), 'no request to the server\'s own port').toEqual([]);
				test.info().annotations.push({ type: 'plugin-repo', description: pluginRepoActivity(webNetwork.entries()).join('; ') || 'none' });
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
