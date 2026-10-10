// The real-server guard (M1-AC19, ADR-0007: "Never point a test at the user's real server"). The harness reads one
// server address from the environment, JOPLIN_SERVER_URL; it accepts it only when it is the published port of a
// running Joplin Server container that this harness started (label io.github.thescriptingguy.notestead.stack-role=server
// on a container labelled io.github.thescriptingguy.notestead.test=stack). Anything else aborts before the harness
// sends a single request: the guard itself only asks podman, it never connects to the URL.
import { spawnSync } from 'node:child_process';

export const testLabel = 'io.github.thescriptingguy.notestead.test';
export const runLabel = 'io.github.thescriptingguy.notestead.test-run';
export const roleLabel = 'io.github.thescriptingguy.notestead.stack-role';
export const projectLabel = 'io.podman.compose.project';

export interface HarnessServer {
	container: string;
	project: string;
	run: string;
	url: string;
}

export class ForeignServerError extends Error {}

// The URL as it may be printed: no credentials, no query.
export const printable = (raw: string): string => {
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
	} catch {
		return JSON.stringify(raw.replace(/\/\/[^/@]*@/, '//<credentials>@').slice(0, 200));
	}
};

const refuse = (raw: string, why: string): ForeignServerError => new ForeignServerError([
	`Refusing to run: JOPLIN_SERVER_URL=${printable(raw)} is not a Joplin Server container started by this test harness (${why}).`,
	'Automated tests never talk to a real Joplin Server (ADR-0007, docs/test-plans/M1-S6.md, M1-AC19); no request was made.',
	'Unset JOPLIN_SERVER_URL to let the harness start a throwaway server, or set it to the URL printed by',
	'`node tests/stack/cli.ts up` (a stack this harness started).',
].join('\n'));

// The running Joplin Server containers this harness started, with their published URL on 127.0.0.1.
export const harnessServers = (): HarnessServer[] => {
	const r = spawnSync('podman', ['ps', '--filter', `label=${testLabel}=stack`, '--filter', `label=${roleLabel}=server`,
		'--format', `{{.Names}}\t{{index .Labels "${projectLabel}"}}\t{{index .Labels "${runLabel}"}}`], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`podman ps failed while checking JOPLIN_SERVER_URL: ${r.stderr}`);
	const servers: HarnessServer[] = [];
	for (const line of r.stdout.split('\n').filter(l => l.trim() !== '')) {
		const [container, project, run] = line.split('\t');
		const port = spawnSync('podman', ['port', container, '22300/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] ?? '';
		const m = /^(127\.0\.0\.1|0\.0\.0\.0):(\d+)$/.exec(port);
		if (m) servers.push({ container, project, run, url: `http://127.0.0.1:${m[2]}` });
	}
	return servers;
};

// Returns undefined when JOPLIN_SERVER_URL is unset or empty (the harness starts its own server), the matching server
// when it names one this harness started, and throws ForeignServerError otherwise.
export const checkServerUrl = (raw: string | undefined, servers: () => HarnessServer[] = harnessServers): HarnessServer | undefined => {
	if (raw === undefined || raw.trim() === '') return undefined;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw refuse(raw, 'not a URL');
	}
	if (url.protocol !== 'http:') throw refuse(raw, 'a harness server is plain http on 127.0.0.1');
	if (url.username !== '' || url.password !== '') throw refuse(raw, 'it carries credentials');
	if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw refuse(raw, `host ${url.hostname} is not this machine's loopback`);
	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw refuse(raw, 'a harness server URL has no path or query');
	const wanted = `http://127.0.0.1:${url.port}`;
	const match = servers().find(s => s.url === wanted);
	if (!match) throw refuse(raw, `no running container labelled ${roleLabel}=server publishes port ${url.port || '80'}`);
	return match;
};
