// The exact control before the app's one online load (docs/test-plans/M2-S5.md RU-1 step 5, RU-18). Pure, so Jest tests it
// (tests/unit/harness/upgradeFlows.test.ts, ro-01…04). The new container may hold the harness's readiness `GET /` and the browser's own
// scheduled update check, `GET /serviceWorker.bundle.js` (a GET carries no data); any other request is named by method and path.
export const unexpectedBeforeLoad = (entries: { method: string; path: string }[]): string[] =>
	entries.filter(e => !(e.method === 'GET' && (e.path === '/' || e.path === '/serviceWorker.bundle.js'))).map(e => `${e.method} ${e.path}`);
