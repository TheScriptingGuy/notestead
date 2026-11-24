// The exact control before the app's one online load (docs/test-plans/M2-S5.md RU-1 step 5, RU-18; ro-01…04): the new container may hold
// the harness's readiness `GET /` and the browser's own `GET /serviceWorker.bundle.js` update check, and nothing else.
import { describe, expect, test } from '@jest/globals';
import { unexpectedBeforeLoad } from '../../e2e/support/beforeLoad.ts';

const entry = (method: string, path: string): { method: string; path: string; status: number; ts: number } => ({ method, path, status: 200, ts: 1 });

describe('entries before the online load', () => {
	test('ro-01 only the readiness GET / is expected', () => {
		expect(unexpectedBeforeLoad([entry('GET', '/'), entry('GET', '/')])).toEqual([]);
	});

	test('ro-02 the browser\'s update check of the worker script is expected too', () => {
		expect(unexpectedBeforeLoad([entry('GET', '/'), entry('GET', '/serviceWorker.bundle.js')])).toEqual([]);
	});

	test('ro-03 a PUT under /joplin-server/ is named', () => {
		expect(unexpectedBeforeLoad([entry('GET', '/'), entry('PUT', '/joplin-server/api/items/root:/x.md:/content')])).toEqual(['PUT /joplin-server/api/items/root:/x.md:/content']);
		expect(unexpectedBeforeLoad([entry('GET', '/joplin-server/api/ping')])).toEqual(['GET /joplin-server/api/ping']);
	});

	test('ro-04 any other request, a GET of a bundle file or a non-GET worker script request, is named', () => {
		expect(unexpectedBeforeLoad([entry('GET', '/app.bundle.js')])).toEqual(['GET /app.bundle.js']);
		expect(unexpectedBeforeLoad([entry('POST', '/serviceWorker.bundle.js')])).toEqual(['POST /serviceWorker.bundle.js']);
	});
});
