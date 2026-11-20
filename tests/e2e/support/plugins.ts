// Plugin helpers for the web app (docs/test-plans/M2-S4.md): the repository prefixes of the network policy, and the flows over the page objects.
import { test } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import { waitFor } from '../../support/poll.ts';
import { redactText } from '../../support/redact.ts';
import { attachText } from './fixtures.ts';
import type { WebApp } from './fixtures.ts';
import type { NetEntry } from './network.ts';
import type { JoplinWebApp, NoteScreen, PluginsScreen } from './pages/joplinWebApp.ts';
import { knownSecretsNow } from './typeLikeUser.ts';
import { pluginNoteToolbarLabel } from './repeatingTodos.ts';

// What upstream's repository client requests from the browser (RepositoryApi.ts at v3.7.21; plan P7, P7a). They go straight
// from the browser to the hosts, not through our proxy, so every M2-S4 spec names them with `webNetwork.allow`.
export const pluginRepositoryPrefixes = [
	'https://raw.githubusercontent.com/joplin/plugins/master/',
	'https://api.github.com/repos/joplin/plugins/',
	'https://cdn.staticaly.com/gh/joplin/plugins/master/',
	'https://ghproxy.com/https://raw.githubusercontent.com/joplin/plugins/master/',
	'https://cdn.jsdelivr.net/gh/joplin/plugins@master/',
	'https://raw.fastgit.org/joplin/plugins/master/',
] as const;

// ---- Flows over the page objects (docs/test-plans/M2-S4.md, D1, D9, D11) ----
// Configuration, Plugins, "Enable plugin support" (the setting is off by default), ending on the plugin list.
export const enablePluginSupport = async (app: JoplinWebApp): Promise<PluginsScreen> => {
	const config = await app.openConfiguration();
	const plugins = await config.openSection('Plugins');
	await plugins.enableButton().click();
	await plugins.noneInstalled().waitFor();
	return plugins;
};

// "Install from file" (under "Advanced settings"): the button opens upstream's hidden file input, which Playwright's file
// chooser answers (the same picker as "Attach file", pickDocument.ts). Waits for the list to show one more plugin.
export const installPluginFromFile = async (plugins: PluginsScreen, path: string, timeoutMs = 120_000): Promise<void> => {
	const heading = plugins.page.getByText(/^Installed \((\d+)\):$/);
	const before = await heading.count() > 0 ? Number(/\((\d+)\)/.exec(await heading.innerText())?.[1] ?? 0) : 0;
	if (!(await plugins.installFromFileButton().isVisible())) await plugins.advancedSettings().click();
	const chooser = plugins.page.waitForEvent('filechooser', { timeout: 30_000 });
	await plugins.installFromFileButton().click();
	await (await chooser).setFiles(path);
	await plugins.installedHeading(before + 1).waitFor({ timeout: timeoutMs });
};

// The plugin runs when its note toolbar command ("Open Recurrence Dialog") is in the open note's action menu. A fresh menu is
// opened for every probe (the item appears when the plugin has registered its views).
export const pluginRunning = async (note: NoteScreen, timeoutMs: number): Promise<void> => {
	await waitFor(`"${pluginNoteToolbarLabel}" in the note's action menu`, async () => ((await note.menuItemNames()).includes(pluginNoteToolbarLabel) ? true : undefined), { timeoutMs, intervalMs: 2_000 });
};

// The requests that went to the plugin repository hosts, as `METHOD host+path status`, sorted and unique (no query string).
export const pluginRepoActivity = (entries: NetEntry[]): string[] => {
	const lines = entries.filter(e => pluginRepositoryPrefixes.some(p => e.url.startsWith(p))).map(e => {
		const url = new URL(e.url);
		return `${e.method} ${url.host}${url.pathname} ${e.status ?? e.failure ?? 'no response'}`;
	});
	return [...new Set(lines)].sort();
};

// On failure only (D9): the browser console lines about plugins. Diagnostic, never a readiness signal.
export const attachPluginConsole = async (webApp: WebApp, testInfo: TestInfo): Promise<void> => {
	if (testInfo.status === testInfo.expectedStatus) return;
	const terms = ['Repeating Todos', 'Recurrence', 'PluginService', 'PluginRunner', 'loadPlugins', 'Could not load plugin'];
	const lines = webApp.console.filter(l => terms.some(t => l.includes(t)));
	await test.step('attach the plugin console', async () => {
		await attachText(testInfo, 'plugin-console.log', redactText(lines.join('\n') || '(no plugin console lines)', knownSecretsNow()));
	});
};
