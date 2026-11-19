// M2-S4 / M2-AC10 (@network; docs/test-plans/M2-S4.md P7, D8): a plugin installed from the official repository in the web app. The
// browser downloads it straight from raw.githubusercontent.com (never through our proxy), the stored bytes are the repository's
// published bytes (their sha256 is the _publish_hash of manifests.json, which the test fetches itself, read-only), and it runs.
// Runs only with NOTESTEAD_NETWORK_TESTS=1 (playwright.config.ts): nightly and on pin bumps in CI. Needs the internet.
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { openUnlockedWebApp } from '../support/flows.ts';
import { endOfTestViolations } from '../support/network.ts';
import { localFilesNamed } from '../support/localProfile.ts';
import { JoplinWebApp, NoteScreen } from '../support/pages/joplinWebApp.ts';
import type { PluginsScreen } from '../support/pages/joplinWebApp.ts';
import { attachPluginConsole, enablePluginSupport, pluginRepositoryPrefixes, pluginRepoActivity, pluginRunning } from '../support/plugins.ts';
import { repeatingTodosFixture } from '../support/repeatingTodos.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';

const manifestsUrl = 'https://raw.githubusercontent.com/joplin/plugins/master/manifests.json';
const fx = repeatingTodosFixture();

interface PublishedPlugin { version: string; hash: string }

// The repository's own record of the plugin, fetched from Node, read-only.
const publishedPlugin = async (): Promise<PublishedPlugin> => {
	const response = await fetch(manifestsUrl);
	if (!response.ok) throw new Error(`GET ${manifestsUrl}: HTTP ${response.status}`);
	const manifests = await response.json() as Record<string, { version?: string; _publish_hash?: string }>;
	const entry = manifests[fx.id];
	if (!entry?._publish_hash) throw new Error(`manifests.json has no _publish_hash for ${fx.id}`);
	return { version: String(entry.version), hash: entry._publish_hash.replace(/^sha256:/, '') };
};

test.describe('M2-S4 plugin repository', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test.afterEach(async ({ webApp }, testInfo) => {
		await attachPluginConsole(webApp, testInfo);
	});

	test('M2-AC10 a plugin installed from the official repository in the web app downloads from raw.githubusercontent.com, stores the published bytes and runs', { tag: '@network' }, async ({ stack, joplinServer, e2eeAccount, webApp, webNetwork }) => {
		await requireUpstreamBundle(stack, 'M2-S4');
		for (const prefix of pluginRepositoryPrefixes) webNetwork.allow(prefix);
		const app = new JoplinWebApp(webApp.page);
		const note = new NoteScreen(webApp.page);
		const origin = new URL(webApp.baseURL).origin;
		const note1 = e2eeAccount.notes?.[0];
		if (!e2eeAccount.folder || !note1) throw new Error('the account has no seeded folder and note');
		let published: PublishedPlugin = { version: '', hash: '' };

		let plugins: PluginsScreen;

		await test.step('1. enable plugin support: no plugins are installed, and the repository loads', async () => {
			published = await publishedPlugin();
			await openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount);
			plugins = await enablePluginSupport(app);
			await expect(plugins.noneInstalled()).toBeVisible();
			await plugins.repositoryLoaded(120_000);
		});

		await test.step('2. search for the plugin and install it from the result', async () => {
			await plugins.search('Repeating To-Dos');
			await plugins.installFromSearch('Repeating To-Dos', 120_000);
			await plugins.clearSearch();
			await expect(plugins.installedHeading(1)).toBeVisible();
			await expect(plugins.card(fx.name)).toBeVisible();
		});

		await test.step('3. running: "Open Recurrence Dialog" is in a note\'s action menu', async () => {
			await app.backToList();
			await app.openNote(note1.title);
			await note.waitOpen();
			await pluginRunning(note, 120_000);
		});

		await test.step('4. OPFS: one stored copy, whose sha256 is the repository\'s published hash', async () => {
			const files = await localFilesNamed(webApp, `${fx.id}.jpl`);
			const again = await publishedPlugin();
			expect(again, 'the repository changed during the test').toEqual(published);
			expect(files, 'one stored copy of the plugin').toHaveLength(1);
			expect(files[0].path).toMatch(/\/plugins\/[^/]+\.jpl$/);
			expect(files[0].sha256).toBe(published.hash);
			test.info().annotations.push({ type: 'ac10', description: `repository version ${published.version}, hash ${published.hash}` });
		});

		await test.step('5. network: downloaded from raw.githubusercontent.com, never from a release; the policy is clean', async () => {
			const download = webNetwork.entries().filter(e => e.method === 'GET' && e.url === `https://raw.githubusercontent.com/joplin/plugins/master/plugins/${fx.id}/plugin.jpl`);
			expect(download.map(e => e.status), 'the plugin download answered 200').toContain(200);
			expect(webNetwork.entries().filter(e => e.url.includes('/releases/download/')).map(e => e.url), 'no release download').toEqual([]);
			expect(endOfTestViolations(webNetwork.entries(), origin, webNetwork.allowed()), 'cross-origin requests outside the plugin repository').toEqual([]);
			test.info().annotations.push({ type: 'plugin-repo', description: pluginRepoActivity(webNetwork.entries()).join('; ') || 'none' });
		});
	});
});
