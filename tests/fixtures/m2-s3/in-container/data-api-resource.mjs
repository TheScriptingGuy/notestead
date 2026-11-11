// Resource probe for the E2E harness (docs/test-plans/M2-S3.md D4, D5). It runs INSIDE a headless container, the only network
// namespace where the CLI's Data API (127.0.0.1:41184) exists, piped to `node -` on stdin by the dataApi fixture. The token is
// read from the profile at call time and never printed, and no file body leaves the container.
//   podman exec -i <c> node - digest <resource id> <timeout ms>
//       GET /resources/:id/file streamed into a sha256: RESULT {"status","sha256","size","contentType"}
//   podman exec -i <c> node - create <timeout ms> <base64 JSON {"title","fileName","mime"}> <base64 file bytes>
//       POST /resources (multipart: props + data): RESULT {"status","body"} (the new resource's metadata)
// Any failure prints RESULT {"error"} and exits 0, so the test reports the reason.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
const print = value => process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);
const withToken = path => {
	const token = JSON.parse(readFileSync('/data/profile/settings.json', 'utf8'))['api.token'];
	if (typeof token !== 'string' || token === '') throw new Error('no api.token in /data/profile/settings.json');
	return `http://127.0.0.1:41184${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
};

try {
	if (mode === 'digest') {
		const [id, timeout] = args;
		if (!/^[0-9a-f]{32}$/.test(id ?? '')) throw new Error('digest: a resource id is 32 hex characters');
		const res = await fetch(withToken(`/resources/${id}/file`), { signal: AbortSignal.timeout(Number(timeout)) });
		const hash = createHash('sha256');
		let size = 0;
		if (res.body) for await (const part of res.body) { hash.update(part); size += part.length; }
		print({ status: res.status, sha256: hash.digest('hex'), size, contentType: res.headers.get('content-type') ?? '' });
	} else if (mode === 'create') {
		const [timeout, metaB64, dataB64] = args;
		const meta = JSON.parse(Buffer.from(metaB64, 'base64').toString('utf8'));
		if (!/^[a-z0-9][a-z0-9.-]*$/.test(meta.fileName ?? '')) throw new Error('create: unsafe file name');
		const form = new FormData();
		form.append('props', JSON.stringify({ title: meta.title }));
		form.append('data', new Blob([Buffer.from(dataB64, 'base64')], { type: meta.mime }), meta.fileName);
		const res = await fetch(withToken('/resources'), { method: 'POST', body: form, signal: AbortSignal.timeout(Number(timeout)) });
		const text = await res.text();
		let body = text;
		try {
			body = JSON.parse(text);
		} catch {
			// not JSON
		}
		print({ status: res.status, body });
	} else {
		throw new Error(`unknown mode ${mode}`);
	}
} catch (error) {
	print({ error: `${error.name}: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''}` });
}
