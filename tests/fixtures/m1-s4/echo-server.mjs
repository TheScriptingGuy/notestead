// Echo upstream for the M1-S4 contract suite (docs/test-plans/M1-S4.md): stands in for the Joplin Server behind the
// web proxy and answers every request with what it received (method, URL, raw headers in order, TCP peer). It also
// sends a cookie and a long-lived Cache-Control, so the tests can prove the proxy strips Set-Cookie (ADR-0002 rule 3)
// and overrides caching (rule 8, M1-AC10 C10). Runs on the official Node image; no dependencies.
import http from 'node:http';

http.createServer((req, res) => {
	const chunks = [];
	req.on('data', chunk => chunks.push(chunk));
	req.on('end', () => {
		const body = JSON.stringify({
			method: req.method,
			url: req.url,
			peer: req.socket.remoteAddress,
			rawHeaders: req.rawHeaders,
			bodyLength: Buffer.concat(chunks).length,
		});
		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Set-Cookie': 'echo-session=m1s4-fixture; Path=/; HttpOnly',
			'Cache-Control': 'public, max-age=3600',
		});
		res.end(body);
	});
}).listen(8080, '0.0.0.0');
