// Health observer for the M1-S5 contract suite (docs/test-plans/M1-S5.md, M1-AC15). It runs in a Node fixture
// container on the backend network, like any peer of the headless service, and polls the supervisor's /healthz.
// argv[2] = URL, argv[3] = interval in ms (default 100). One JSON line per poll on stdout:
//   {"n","t","status","type","body"} or {"n","t","error"}; t is Date.now() (the host clock, shared by all containers).
const url = process.argv[2];
const intervalMs = Number(process.argv[3] ?? '100');

let n = 0;
for (;;) {
	n++;
	const t = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
		const body = (await res.text()).slice(0, 500);
		process.stdout.write(`${JSON.stringify({ n, t, status: res.status, type: res.headers.get('content-type') ?? '', body })}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ n, t, error: error.cause?.code ?? error.name })}\n`);
	}
	await new Promise(resolve => setTimeout(resolve, intervalMs));
}
