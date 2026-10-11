// Data API request probe for the E2E harness (docs/test-plans/M1-S7.md §Fixtures). It runs INSIDE a headless container,
// the only network namespace where the CLI's Data API (127.0.0.1:41184) exists, piped to `node -` on stdin by the
// `dataApi` fixture (tests/e2e/support/fixtures.ts): no test file is mounted into the container and the token never
// leaves it.
//   podman exec -i <container> node - <METHOD> <path> [<base64 JSON body>]
// The token is read from the CLI profile (`api.token` in /data/profile/settings.json) at call time, so a token rotated
// by a restart of the service is always current. Prints one line `RESULT {"status", "body"}`; the token is never
// printed. Any failure prints `RESULT {"error"}` and exits 0, so the test reports the reason.
// Bodies are made by the test (titles and text, never `file:` or `http(s):` image URLs; CLAUDE.md security rules).
import { readFileSync } from 'node:fs';

const [method = 'GET', path = '/ping', encodedBody] = process.argv.slice(2);
const port = 41184;

const print = value => process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);

try {
	const settings = JSON.parse(readFileSync('/data/profile/settings.json', 'utf8'));
	const token = settings['api.token'];
	if (typeof token !== 'string' || token === '') throw new Error('no api.token in /data/profile/settings.json');
	const url = `http://127.0.0.1:${port}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
	const init = { method, signal: AbortSignal.timeout(30_000) };
	if (encodedBody) {
		init.body = Buffer.from(encodedBody, 'base64').toString('utf8');
		init.headers = { 'Content-Type': 'application/json' };
	}
	const res = await fetch(url, init);
	const text = await res.text();
	let body = text;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON
	}
	print({ status: res.status, body });
} catch (error) {
	print({ error: `${error.name}: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''}` });
}
