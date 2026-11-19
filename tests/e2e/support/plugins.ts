// Plugin helpers for the web app (docs/test-plans/M2-S4.md). The page-object helpers join this file in WO-4.

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
