// Harness for the M1-S5 `headless` contract suite (docs/test-plans/M1-S5.md §Image contract, §Contract stack).
// - Images, built lazily once per run and shared by the suite's files (a record per image under <work>/images/, removed
//   by globalTeardown): the headless image under test (packages/headless/Containerfile, built from a clean copy of the
//   repository's files) and the CLI "other device" fixture image (tests/fixtures/m1-s5/device, never the image under
//   test).
// - The ADR-0006 topology: a `front` network (server, web, other device) and an `--internal` `back` network (web's
//   internal listener :8089 and the headless container, nothing else). The headless container is on `back` only.
// - Per test: a fresh server user (strong unique password), a fresh E2EE "other device", fresh secrets, a fresh
//   headless container and profile volume.
// Secrets are passed to podman by bind-mounted files and to fixtures on stdin, never in argv or env.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	containerLogs, containerName, exitedWith, freeSubnetPrefix, ipOf, nodeImage, podman, redact, repoRoot, runId, runLabel,
	testLabel, waitFor,
} from './podman.ts';
import type { Stack } from './podman.ts';
import { direct, startJoplinServer, startWeb, webEnvFor } from './services.ts';
import type { JoplinServer, Web } from './services.ts';

export const story = 'm1-s5';
export const resultsDir = join(repoRoot, 'test-results', 'contract', story);
export const fixtures = join(repoRoot, 'tests', 'fixtures', story);
export const inContainerDir = join(fixtures, 'in-container');
export const inContainerMount = '/opt/notestead-test';
export const headlessContainerfileRel = 'packages/headless/Containerfile';
export const headlessTag = 'localhost/notestead-headless:m1-s5-test';
export const healthPort = 8090;
export const dataApiPort = 41184;
export const gateFile = '/tmp/.nst-watch-ready';

interface FullPin {
	cli: { npm: string; version: string };
	server: { image: string; tag: string };
	syncVersion: number;
}

export const readFullPin = (): FullPin => JSON.parse(readFileSync(join(repoRoot, 'upstream', 'joplin-version.json'), 'utf8')) as FullPin;

const work = (): string => {
	const dir = process.env.NOTESTEAD_CONTRACT_WORK;
	if (!dir) throw new Error('the contract globalSetup did not run: use `corepack yarn jest -c jest.contract.config.js`');
	return dir;
};

// ---- Logged commands ----

export interface Logged {
	code: number | null;
	stdout: string;
	stderr: string;
	log: string;
}

// Runs a command, writes its redacted output to test-results/contract/m1-s5/<label>.log. `secrets` are replaced by
// their labels in the log (the test secrets are throwaway, but no artifact carries a secret value).
export const runLogged = (label: string, cmd: string, args: string[], opts: { input?: string; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; secrets?: Secret[] } = {}): Logged => {
	mkdirSync(resultsDir, { recursive: true });
	const started = Date.now();
	const r = spawnSync(cmd, args, { cwd: opts.cwd ?? repoRoot, input: opts.input, encoding: 'utf8', timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 256 * 1024 * 1024, env: opts.env ?? process.env });
	const log = join(resultsDir, `${label}.log`);
	const text = `$ ${cmd} ${args.join(' ')}\n# exit ${r.status} signal ${r.signal} after ${Date.now() - started} ms${r.error ? ` error ${r.error.message}` : ''}\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`;
	writeFileSync(log, scrub(text, opts.secrets ?? []));
	return { code: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}` : ''}`, log };
};

export const scrub = (text: string, secrets: Secret[]): string => {
	let out = text;
	for (const s of secrets) for (const v of [s.value, s.core]) out = out.split(v).join(`[${s.label}]`);
	return redact(out);
};

// ---- Images (lazy, once per run) ----

interface ImageRecord {
	image?: string;
	error?: string;
	prebuilt?: boolean;
}

export const lazyImage = (key: string, build: () => ImageRecord): string => {
	const file = join(work(), 'images', `${key}.json`);
	if (!existsSync(file)) {
		mkdirSync(dirname(file), { recursive: true });
		let record: ImageRecord;
		try {
			record = build();
		} catch (error) {
			record = { error: (error as Error).message };
		}
		writeFileSync(file, JSON.stringify(record));
	}
	const record = JSON.parse(readFileSync(file, 'utf8')) as ImageRecord;
	if (record.error || !record.image) throw new Error(record.error ?? `no image recorded for ${key}`);
	return record.image;
};

// Copies the repository's files as a fresh checkout would have them (tracked plus untracked-but-not-ignored), so the
// build never sees local node_modules, caches or test results.
export const cleanContext = (into: string): void => {
	const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
	rmSync(into, { recursive: true, force: true });
	for (const rel of listed.stdout.split('\0').filter(p => p !== '')) {
		const src = join(repoRoot, rel);
		try {
			lstatSync(src);
		} catch {
			continue; // deleted in the work tree
		}
		mkdirSync(dirname(join(into, rel)), { recursive: true });
		cpSync(src, join(into, rel), { verbatimSymlinks: true });
	}
};

export const buildHeadlessFrom = (context: string, tag: string, label: string): void => {
	const containerfile = join(context, headlessContainerfileRel);
	if (!existsSync(containerfile)) {
		throw new Error(`Contract (docs/test-plans/M1-S5.md §Image contract): missing ${headlessContainerfileRel}; the headless image cannot be built`);
	}
	const built = runLogged(label, 'podman', ['build', '-f', containerfile, '--label', `${testLabel}=contract`, '-t', tag, context], { timeoutMs: 60 * 60_000 });
	if (built.code !== 0) throw new Error(`podman build of ${tag} failed (exit ${built.code}; log ${built.log}):\n${redact(`${built.stdout}\n${built.stderr}`).slice(-3000)}`);
};

// The headless image under test. NOTESTEAD_HEADLESS_IMAGE=<ref> uses a prebuilt image instead (a pipeline-built image,
// or QA's harness validation); the build-path assertions of M1-AC23 then still run against that image.
export const headlessImage = (): string => lazyImage('headless', () => {
	if (process.env.NOTESTEAD_HEADLESS_IMAGE) return { image: process.env.NOTESTEAD_HEADLESS_IMAGE, prebuilt: true };
	const context = join(work(), 'headless-context');
	cleanContext(context);
	buildHeadlessFrom(context, headlessTag, 'build-headless');
	return { image: headlessTag };
});

export const deviceImage = (): string => lazyImage('device', () => {
	const { cli } = readFullPin();
	const tag = `localhost/notestead-test-device:${cli.version}`;
	const dir = join(fixtures, 'device');
	const built = runLogged('build-device', 'podman', ['build', '-f', join(dir, 'Containerfile'), '--build-arg', `JOPLIN_CLI_VERSION=${cli.version}`,
		'--label', `${testLabel}=contract`, '-t', tag, dir], { timeoutMs: 30 * 60_000 });
	if (built.code !== 0) throw new Error(`the device fixture image failed to build (log ${built.log}): ${built.stderr.slice(-2000)}`);
	return { image: tag };
});

// ---- Stack ----

export interface Back {
	name: string;
	prefix: string;
}

export interface HeadlessStack {
	stack: Stack;
	back: Back;
	server: JoplinServer;
	web: Web;
	// web's address on `back` (its internal listener :8089)
	webBackIp: string;
}

// Fixed addresses. front: web .20, server .30, device .40. back: web .20, headless .60, observer .70, client .71.
export const hosts = { web: 20, server: 30, device: 40, headless: 60, observer: 70, client: 71 };

export const createBack = (stack: Stack): Back => {
	const prefix = freeSubnetPrefix();
	const name = `nst-${stack.suite}-back-${runId()}`;
	podman(['network', 'create', '--internal', '--subnet', `${prefix}.0/24`, '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, name]);
	return { name, prefix };
};

export const connectWebToBack = (web: Web, back: Back): string => {
	const ip = `${back.prefix}.${hosts.web}`;
	podman(['network', 'connect', '--ip', ip, '--alias', 'web', back.name, web.name]);
	return ip;
};

// A short-lived Node client on `back` (the M1-S4 http-client fixture): proves the internal sync path works.
export const backClient = (hs: HeadlessStack, requests: { method?: string; url: string; headers?: Record<string, string>; body?: string }[]): { status: number; body: string }[] => {
	const name = containerName(hs.stack, `backclient-${Date.now().toString(36)}`);
	const r = podman(['run', '--rm', '--name', name, '--network', hs.back.name, '--ip', `${hs.back.prefix}.${hosts.client}`,
		'--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`,
		'-v', `${join(repoRoot, 'tests', 'fixtures', 'm1-s4', 'http-client.mjs')}:/fixture/http-client.mjs:ro,Z`,
		nodeImage, 'node', '/fixture/http-client.mjs', JSON.stringify({ requests })], { allowFail: true });
	const line = r.stdout.trim().split('\n').pop() ?? '';
	if (r.code !== 0 || !line.startsWith('[')) throw new Error(`back client failed (exit ${r.code}): ${redact(`${r.stdout}\n${r.stderr}`).slice(-2000)}`);
	return JSON.parse(line) as { status: number; body: string }[];
};

// ---- Server users ----

export interface Secret {
	label: string;
	value: string;
	// A plain [a-z0-9] part of the value that survives any escaping (JSON, shell, URL): the watcher searches for both.
	core: string;
}

// Values with a space, a non-ASCII letter, `$` and `!` (shell and JSON hazards), but no quote, backslash or newline
// (the other device's batch file quotes them).
export const makeSecret = (label: string): Secret => {
	const core = `nst${label.replace(/[^a-z]/gi, '').toLowerCase()}${randomBytes(12).toString('hex')}`;
	return { label, core, value: `${core} Δ$x!` };
};

export interface User {
	email: string;
	password: Secret;
}

const json = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

// One connection per request: Node's global agent keeps sockets alive, and a socket the server closed while a test
// waited (the other device takes ~20 s) fails the next request with "socket hang up".
const noReuse = { Connection: 'close' };

export const sessionFor = async (server: JoplinServer, email: string, password: string): Promise<string> => {
	const res = await direct(server, '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...noReuse }, body: JSON.stringify({ email, password }) });
	const id = (json(res.text) as { id?: string }).id;
	if (res.status !== 200 || !id) throw new Error(`login of ${email} returned ${res.status}: ${res.text.slice(0, 300)}`);
	return id;
};

// A fresh user per test through the admin API (ADR-0007): POST /api/users, then PATCH its password.
export const createUser = async (server: JoplinServer): Promise<User> => {
	const admin = await sessionFor(server, 'admin@localhost', 'admin');
	const email = `m1s5-${randomBytes(6).toString('hex')}@example.com`;
	const created = await direct(server, '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-AUTH': admin, ...noReuse }, body: JSON.stringify({ email, full_name: 'M1-S5 test user' }) });
	const id = (json(created.text) as { id?: string }).id;
	if (created.status !== 200 || !id) throw new Error(`POST /api/users returned ${created.status}: ${created.text.slice(0, 300)}`);
	const password = makeSecret('joplin_password');
	const patched = await direct(server, `/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-API-AUTH': admin, ...noReuse }, body: JSON.stringify({ password: password.value, must_set_password: 0 }) });
	if (patched.status !== 200 && patched.status !== 204) throw new Error(`PATCH /api/users/${id} returned ${patched.status}: ${patched.text.slice(0, 300)}`);
	await sessionFor(server, email, password.value); // the password works
	return { email, password };
};

// The raw item a client uploaded for a note, read straight from the server as that user.
export const serverItem = async (server: JoplinServer, user: User, itemId: string): Promise<{ status: number; text: string }> => {
	const session = await sessionFor(server, user.email, user.password.value);
	const res = await direct(server, `/api/items/root:/${itemId}.md:/content`, { headers: { 'X-API-AUTH': session, ...noReuse } });
	return { status: res.status, text: res.text };
};

// ---- The other device (E2EE) ----

export interface SeededNote {
	id: string;
	title: string;
	body: string;
}

export interface Seeded {
	folder: string;
	notes: SeededNote[];
	e2ee: string;
}

export const seedDevice = (hs: HeadlessStack, user: User, master: Secret, label: string): Seeded => {
	const tag = randomBytes(5).toString('hex');
	const folder = `M1-S5 folder ${tag}`;
	const notes = [{ title: `M1-S5 note ${tag}`, body: `Decrypted body ${tag} zebracorn` }];
	const name = containerName(hs.stack, `device-${label}`);
	const r = runLogged(`device-${label}`, 'podman', ['run', '--rm', '-i', '--name', name, '--network', hs.stack.net, '--ip', ipOf(hs.stack, hosts.device),
		'--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, deviceImage()], {
		input: JSON.stringify({ syncUrl: `http://${hs.web.ip}:8080/joplin-server`, email: user.email, password: user.password.value, masterPassword: master.value, folder, notes }),
		timeoutMs: 10 * 60_000,
		secrets: [user.password, master],
	});
	const line = r.stdout.split('\n').filter(l => l.startsWith('RESULT ')).pop();
	if (r.code !== 0 || !line) throw new Error(`the other device failed (exit ${r.code}; log ${r.log}):\n${scrub(`${r.stdout}\n${r.stderr}`, [user.password, master]).slice(-2000)}`);
	const result = JSON.parse(line.slice('RESULT '.length)) as { e2ee: string; notes: { id: string; title: string }[] };
	return { folder, e2ee: result.e2ee, notes: result.notes.map(n => ({ ...n, body: notes.find(s => s.title === n.title)?.body ?? '' })) };
};

// ---- The headless container under test ----

export interface Headless {
	name: string;
	ip: string;
	volume: string;
	secretsDir: string;
	secrets: Secret[];
}

export interface HeadlessOptions {
	label: string;
	env: Record<string, string>;
	password: Secret;
	master: Secret;
	// Hold the image's own entrypoint until the process watcher is attached (see the test plan, M1-AC14).
	gate?: boolean;
}

export const headlessHardening = ['--init', '--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--memory', '768m'];

export const startHeadless = (hs: HeadlessStack, opts: HeadlessOptions): Headless => {
	const image = headlessImage();
	const secretsDir = mkdtempSync(join(tmpdir(), 'm1s5-secrets-'));
	// joplin_password ends with a newline (as `echo pw > file` writes it), e2ee_master_password doesn't: the contract
	// strips exactly one trailing newline.
	writeFileSync(join(secretsDir, 'joplin_password'), `${opts.password.value}\n`, { mode: 0o444 });
	writeFileSync(join(secretsDir, 'e2ee_master_password'), opts.master.value, { mode: 0o444 });
	const name = containerName(hs.stack, `headless-${opts.label}`);
	const volume = `nst-${hs.stack.suite}-data-${opts.label}-${runId()}`;
	podman(['volume', 'create', '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, volume]);
	const ip = `${hs.back.prefix}.${hosts.headless}`;
	const args = ['run', '-d', '--name', name, '--network', hs.back.name, '--ip', ip, '--network-alias', 'headless',
		'--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, ...headlessHardening,
		'-v', `${volume}:/data`,
		'-v', `${join(secretsDir, 'joplin_password')}:/run/secrets/joplin_password:ro,Z`,
		'-v', `${join(secretsDir, 'e2ee_master_password')}:/run/secrets/e2ee_master_password:ro,Z`,
		'-v', `${inContainerDir}:${inContainerMount}:ro,Z`];
	for (const [key, value] of Object.entries(opts.env)) args.push('-e', `${key}=${value}`);
	if (opts.gate) {
		const config = JSON.parse(podman(['image', 'inspect', '--format', '{{json .Config}}', image]).stdout) as { Entrypoint?: string[] | null; Cmd?: string[] | null };
		const original = [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])];
		if (original.length === 0) throw new Error(`${image} has neither ENTRYPOINT nor CMD`);
		args.push('--entrypoint', '/bin/sh', image, '-c', `while [ ! -e ${gateFile} ]; do sleep 0.05; done; exec "$@"`, 'nst-gate', ...original);
	} else {
		args.push(image);
	}
	hs.stack.containers.push(name);
	podman(args);
	return { name, ip, volume, secretsDir, secrets: [opts.password, opts.master] };
};

// Writes the container's log (secrets scrubbed, token= redacted), removes it, its volume and the secrets dir.
export const stopHeadless = (hs: HeadlessStack, h: Headless | undefined): void => {
	if (!h) return;
	writeFileSync(join(hs.stack.logsDir, `${h.name}.log`), scrub(containerLogs(h.name), h.secrets));
	podman(['rm', '-f', '-t', '0', h.name], { allowFail: true });
	hs.stack.containers = hs.stack.containers.filter(c => c !== h.name);
	podman(['volume', 'rm', '-f', h.volume], { allowFail: true });
	rmSync(h.secretsDir, { recursive: true, force: true });
};

export const execIn = (container: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): { code: number | null; stdout: string; stderr: string } => {
	const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
	return podman(['exec', ...envArgs, container, ...args], { allowFail: true, timeoutMs: opts.timeoutMs ?? 120_000 });
};

export interface DataApiResult {
	status?: number;
	body?: unknown;
	error?: string;
}

// GET on the CLI's Data API from inside the headless container (127.0.0.1:41184).
export const dataApi = (h: Headless, path: string, { token = true } = {}): DataApiResult => {
	const r = execIn(h.name, ['node', `${inContainerMount}/data-api.mjs`, ...(token ? [] : ['--no-token']), path]);
	const line = r.stdout.split('\n').filter(l => l.startsWith('RESULT ')).pop();
	if (!line) return { error: `data-api probe printed no result (exit ${r.code}): ${redact(`${r.stdout}\n${r.stderr}`).slice(-1000)}` };
	return JSON.parse(line.slice('RESULT '.length)) as DataApiResult;
};

// ---- Health observer (a peer on `back`) ----

export interface HealthLine {
	n: number;
	t: number;
	status?: number;
	type?: string;
	body?: string;
	error?: string;
}

export const startObserver = (hs: HeadlessStack, label: string, target = `${hs.back.prefix}.${hosts.headless}`): string => {
	const name = containerName(hs.stack, `observer-${label}`);
	podman(['run', '-d', '--name', name, '--network', hs.back.name, '--ip', `${hs.back.prefix}.${hosts.observer}`,
		'--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`,
		'-v', `${join(fixtures, 'health-watch.mjs')}:/fixture/health-watch.mjs:ro,Z`,
		nodeImage, 'node', '/fixture/health-watch.mjs', `http://${target}:${healthPort}/healthz`, '100']);
	hs.stack.containers.push(name);
	return name;
};

export const healthLines = (observer: string): HealthLine[] => containerLogs(observer).split('\n')
	.filter(l => l.startsWith('{'))
	.map(l => JSON.parse(l) as HealthLine);

export const stopContainer = (hs: HeadlessStack, name: string | undefined): void => {
	if (!name) return;
	writeFileSync(join(hs.stack.logsDir, `${name}.log`), redact(containerLogs(name)));
	podman(['rm', '-f', '-t', '0', name], { allowFail: true });
	hs.stack.containers = hs.stack.containers.filter(c => c !== name);
};

export const parseBody = (line: HealthLine): Record<string, unknown> | null => {
	try {
		const value = JSON.parse(line.body ?? '') as unknown;
		return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
};

// Waits until the observer has seen `GET /healthz` → 200; returns every line up to then.
export const waitForReady = async (observer: string, h: Headless, timeoutMs = 10 * 60_000): Promise<HealthLine[]> => waitFor(`${h.name} GET /healthz → 200`, async () => {
	const lines = healthLines(observer);
	return lines.some(l => l.status === 200) ? lines : undefined;
}, { timeoutMs, intervalMs: 1_000, failFast: () => exitedWith(h.name) });

// ---- Process watcher (inside the headless container) ----

export interface WatchedProcess {
	pid: number;
	starttime: string;
	argv: string[];
	firstSeen: number;
	lastSeen: number;
	states: string[];
	fd0?: string;
}

export interface WatchReport {
	samples: number;
	durationMs: number;
	processes: WatchedProcess[];
	hits: { label: string; pid: number; where: 'cmdline' | 'environ' }[];
	unreadable: { pid: number; file: string; argv: string[] }[];
}

export interface Watcher {
	child: ChildProcessWithoutNullStreams;
	output: () => string;
	// processes that have ended so far (live)
	gone: () => WatchedProcess[];
	stop: () => Promise<WatchReport>;
}

// Attaches proc-watch.mjs to a (gated) headless container. Needle values travel on stdin only.
export const startWatcher = async (h: Headless, needles: { label: string; value: string }[]): Promise<Watcher> => {
	const child = spawn('podman', ['exec', '-i', h.name, 'node', `${inContainerMount}/proc-watch.mjs`], { stdio: ['pipe', 'pipe', 'pipe'] });
	let out = '';
	let errorOutput = '';
	child.stdout.on('data', (chunk: Buffer) => {
		out += chunk.toString('utf8');
	});
	child.stderr.on('data', (chunk: Buffer) => {
		errorOutput += chunk.toString('utf8');
	});
	const closed = new Promise<number | null>(resolve => child.on('close', resolve));
	child.stdin.write(`${JSON.stringify({ needles, readyFile: gateFile, intervalMs: 10 })}\n`);
	await waitFor(`the process watcher in ${h.name}`, async () => (out.includes('WATCHING') ? true : undefined), {
		timeoutMs: 60_000,
		failFast: () => (child.exitCode !== null ? `watcher exited ${child.exitCode}: ${errorOutput.slice(-1000)}` : exitedWith(h.name)),
	});
	return {
		child,
		output: () => out,
		gone: () => out.split('\n').filter(l => l.startsWith('GONE ')).map(l => JSON.parse(l.slice('GONE '.length)) as WatchedProcess),
		stop: async () => {
			child.stdin.end();
			const code = await closed;
			const line = out.split('\n').filter(l => l.startsWith('REPORT ')).pop();
			if (!line) throw new Error(`the process watcher printed no report (exit ${code}): ${errorOutput.slice(-1000)}`);
			return JSON.parse(line.slice('REPORT '.length)) as WatchReport;
		},
	};
};

// A CLI child process: an argv element that is the CLI's bin (`…/joplin`, `…/joplin/main.js`).
export const isCli = (p: WatchedProcess): boolean => p.argv.some(a => /(^|\/)joplin(\/main\.js)?$/.test(a));
export const hasTokens = (p: WatchedProcess, ...tokens: string[]): boolean => tokens.every(t => p.argv.includes(t));
export const cliCommand = (p: WatchedProcess): string[] => {
	const i = p.argv.findIndex(a => /(^|\/)joplin(\/main\.js)?$/.test(a));
	const rest = p.argv.slice(i + 1);
	const out: string[] = [];
	for (let j = 0; j < rest.length; j++) {
		if (rest[j] === '--profile') {
			j++;
			continue;
		}
		out.push(rest[j]);
	}
	return out;
};

// ---- Stack lifecycle ----

// server (testing) and web on `front`; web also on `back` with the alias `web` (its internal listener :8089).
export const startStack = async (stack: Stack, back: Back): Promise<HeadlessStack> => {
	const server = await startJoplinServer(stack, { role: 'server', host: hosts.server, testing: true });
	const web = await startWeb(stack, { role: 'web', host: hosts.web, env: webEnvFor(server.url) });
	const webBackIp = connectWebToBack(web, back);
	return { stack, back, server, web, webBackIp };
};

export const removeBack = (back: Back | undefined): void => {
	if (back) podman(['network', 'rm', '-f', back.name], { allowFail: true });
};

// ---- Image probe (M1-AC23) ----

export interface ProbedPackage {
	dir: string;
	name: string;
	version: string;
	bundles: boolean;
}

export interface ProbedJoplin {
	dir: string;
	sqlite3?: { dir?: string; version?: string; binding?: string; bindingMachine?: string; bindingError?: string; query?: { version?: string; error?: string }; error?: string };
	version?: { code?: number | null; stdout?: string; stderr?: string; error?: string };
}

export interface ImageProbe {
	arch: string;
	uid: number;
	dataMode: string | null;
	packages: ProbedPackage[];
	nodeFiles: string[];
	markers: string[];
	joplin: ProbedJoplin[];
}

// Runs image-probe.mjs in the image with its entrypoint replaced (nothing of the supervisor starts), hardened.
export const probeImage = (image: string, label: string): ImageProbe => {
	const r = runLogged(`probe-${label}`, 'podman', ['run', '--rm', '--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
		'--label', `${testLabel}=contract`, '-v', `${inContainerDir}:${inContainerMount}:ro,Z`, '--entrypoint', 'node', image, `${inContainerMount}/image-probe.mjs`], { timeoutMs: 15 * 60_000 });
	const line = r.stdout.split('\n').filter(l => l.startsWith('RESULT ')).pop();
	if (r.code !== 0 || !line) throw new Error(`image probe failed in ${image} (exit ${r.code}; log ${r.log}): ${r.stderr.slice(-2000)}`);
	return JSON.parse(line.slice('RESULT '.length)) as ImageProbe;
};

// The Node base image's own tools (npm, corepack, yarn classic) are not part of what this repo installs.
export const baseToolPrefixes = ['/usr/local/lib/node_modules/npm/', '/usr/local/lib/node_modules/corepack/', '/opt/yarn-v'];
export const isBaseTool = (dir: string): boolean => baseToolPrefixes.some(p => `${dir}/`.startsWith(p));

// The installed packages this repo is responsible for: not base tools, not inside a package that bundles its own deps.
export const appPackages = (probe: ImageProbe): ProbedPackage[] => {
	const bundlers = probe.packages.filter(p => p.bundles).map(p => `${p.dir}/`);
	return probe.packages.filter(p => !isBaseTool(p.dir) && !bundlers.some(b => p.dir.startsWith(b)));
};

export const ownerOf = (probe: ImageProbe, file: string): ProbedPackage | undefined =>
	probe.packages.filter(p => file.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];

export const expectedMachine = (): string => ({ arm64: 'aarch64', x64: 'x86_64' } as Record<string, string>)[process.arch] ?? process.arch;
export const podmanArch = (): string => ({ arm64: 'arm64', x64: 'amd64' } as Record<string, string>)[process.arch] ?? process.arch;

// This repo's own install on the host (same yarn.lock, install scripts off): name@version → package dirs. The
// reference for "which binaries ship in the package tarballs" (M1-AC23: nothing else may be built).
export const hostPackageDirs = (): Map<string, string[]> => {
	const index = new Map<string, string[]>();
	const visit = (nodeModules: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(nodeModules);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith('.')) continue;
			const dirs = entry.startsWith('@') ? readdirSync(join(nodeModules, entry)).map(e => join(nodeModules, entry, e)) : [join(nodeModules, entry)];
			for (const dir of dirs) {
				if (lstatSync(dir).isSymbolicLink()) continue;
				try {
					const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
					if (manifest.name) {
						const key = `${manifest.name}@${manifest.version}`;
						index.set(key, [...(index.get(key) ?? []), dir]);
					}
				} catch {
					// not a package
				}
				visit(join(dir, 'node_modules'));
			}
		}
	};
	visit(join(repoRoot, 'node_modules'));
	for (const workspace of readdirSync(join(repoRoot, 'packages'))) visit(join(repoRoot, 'packages', workspace, 'node_modules'));
	return index;
};
