// Data API probe for the M1-S5 contract suite (docs/test-plans/M1-S5.md §How the tests reach the Data API). It runs
// INSIDE the headless container under test, the only network namespace where the CLI's Data API (127.0.0.1:41184)
// exists: `podman exec <c> node /opt/notestead-test/data-api.mjs [--no-token] <path>`.
// The token is read from the CLI profile (`api.token` in /data/profile/settings.json, where `config --import` stores
// it) at call time, so a rotated token is always current. Prints one line `RESULT {"status", "body"}`; the token is
// never printed. Any failure prints `RESULT {"error"}` and exits 0 so the test reports the reason.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const withToken = !args.includes('--no-token');
const path = args.filter(a => a !== '--no-token')[0] ?? '/ping';
const port = 41184;

const print = value => process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);

try {
	let url = `http://127.0.0.1:${port}${path}`;
	if (withToken) {
		const settings = JSON.parse(readFileSync('/data/profile/settings.json', 'utf8'));
		const token = settings['api.token'];
		if (typeof token !== 'string' || token === '') throw new Error('no api.token in /data/profile/settings.json');
		url += `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
	}
	const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	const text = await res.text();
	let body = text;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON (for example /ping's "JoplinClipperServer")
	}
	print({ status: res.status, body });
} catch (error) {
	print({ error: `${error.name}: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''}` });
}
