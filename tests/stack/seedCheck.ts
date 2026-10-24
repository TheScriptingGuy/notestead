// The post-condition of the E2EE seed (docs/test-plans/DNS-1.md DNS1-AC4), checked on the server's own copy of
// `info.json` (read directly, not through the proxy): it names at least one master key and has E2EE switched on. A seed
// sync that failed silently leaves no info.json, or one without a master key, and the headless service then loops on
// "no master key is currently loaded" until a fixture timeout. Returns a reason, or undefined when the seed is good.
export const checkSeededInfo = (status: number, text: string): string | undefined => {
	if (status !== 200) return `info.json is not on the server (HTTP ${status})`;
	let info: unknown;
	try {
		info = JSON.parse(text);
	} catch {
		return 'info.json is not valid JSON';
	}
	if (info === null || typeof info !== 'object') return 'info.json is not a JSON object';
	const { masterKeys, e2ee } = info as { masterKeys?: unknown; e2ee?: { value?: unknown } };
	if (!Array.isArray(masterKeys) || masterKeys.length === 0) return 'info.json has no master key';
	if (e2ee?.value !== true) return 'info.json does not have E2EE switched on (e2ee.value is not true)';
	return undefined;
};
