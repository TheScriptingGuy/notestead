// Fixture HTTP client for the M1-S4 contract suite (docs/test-plans/M1-S4.md). Runs in a short-lived Node container at
// a fixed address on the test network, so the web container sees a known TCP peer (the cloudflared stand-in, an
// untrusted peer, distinct LAN clients). argv[2] is {"requests":[{method,url,headers,body}]}; the requests run in
// order and one JSON array of {status, headers, body} is written to stdout. node:http sets any header as given.
import http from 'node:http';

const plan = JSON.parse(process.argv[2]);

const send = r => new Promise((resolve, reject) => {
	const url = new URL(r.url);
	const req = http.request({
		hostname: url.hostname,
		port: url.port,
		path: `${url.pathname}${url.search}`,
		method: r.method ?? 'GET',
		headers: r.headers ?? {},
	}, res => {
		const chunks = [];
		res.on('data', chunk => chunks.push(chunk));
		res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
		res.on('error', reject);
	});
	req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${r.method ?? 'GET'} ${r.url}`)));
	req.on('error', reject);
	req.end(r.body);
});

const results = [];
for (const r of plan.requests) results.push(await send(r));
process.stdout.write(`${JSON.stringify(results)}\n`);
