// The compose test stack (docs/test-plans/M1-S6.md §Compose test stack; ADR-0006, ADR-0007). One API for every runner:
// the Playwright globalSetup and fixtures (tests/e2e/support), the M1-S6 contract self-tests and the developer CLI
// (tests/stack/cli.ts). Shared by Jest (CommonJS) and Playwright/Node (ESM): no __dirname, no import.meta.
// Lifecycle:
//   newStack()      guard (M1-AC19), names, work dir; nothing started yet
//   upCore()        `podman compose up -d server web`; every service must reach `healthy` (M1-AC18), else abort naming it
//   createAccount() a fresh user through the admin API (strong unique password)
//   enableE2ee()    the CLI "other device" turns E2EE on for that account and seeds notes (ADR-0007 `e2eeAccount`)
//   upHeadless()    one compose project per account (compose.headless.yaml), on the stack's `back` network, healthy
//   downStack()     logs written (redacted), every compose project down with volumes, the run's labels swept, the
//                   work dir and the images this process built removed
// The JOPLIN_SERVER_URL guard runs before anything else, and every request to the server goes through `serverRequest`,
// which only accepts this stack's own published port.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../contract/support/http.ts';
import type { HttpResponse } from '../contract/support/http.ts';
import { waitFor } from '../support/poll.ts';
import { redactText } from '../support/redact.ts';
import type { KnownSecret } from '../support/redact.ts';
import { findRepoRoot } from '../support/repoRoot.ts';
import { checkServerUrl, projectLabel, roleLabel, runLabel, testLabel } from './guard.ts';
import type { HarnessServer } from './guard.ts';
import { removeBuiltImages, resolveImages } from './images.ts';
import type { StackImages } from './images.ts';

export const stackDir = (): string => join(findRepoRoot(), 'tests', 'stack');
export const coreServices = ['server', 'web'] as const;
export const publicHost = 'joplin.example.test';
export const publicUrl = `https://${publicHost}`;

export interface Account {
	email: string;
	password: string;
	masterPassword: string;
	e2ee?: string;
	folder?: string;
	notes?: { id: string; title: string; body: string }[];
}

export interface HeadlessService {
	label: string;
	project: string;
	container: string;
	secretsDir: string;
	email: string;
}

export interface StackState {
	project: string;
	run: string;
	// true for the process that started the stack (it saves the descriptor and tears the stack down)
	owned: boolean;
	// true when this run attached to a stack another process started (JOPLIN_SERVER_URL, reuse mode)
	attached?: boolean;
	overrides: string[];
	images: StackImages;
	workDir: string;
	logsDir: string;
	frontNetwork: string;
	backNetwork: string;
	containers: Partial<Record<'server' | 'web', string>>;
	serverUrl?: string;
	webUrl?: string;
	accounts: Account[];
	headless: HeadlessService[];
	defaultAccount?: Account;
	defaultHeadless?: HeadlessService;
}

export class StackHealthError extends Error {
	public readonly service: string;
	public constructor(service: string, message: string) {
		super(message);
		this.service = service;
	}
}

// ---- podman and compose ----

export const podmanSync = (args: string[], { allowFail = false, timeoutMs = 5 * 60_000 } = {}): { code: number | null; stdout: string; stderr: string } => {
	const r = spawnSync('podman', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	const out = { code: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}` : ''}` };
	if (!allowFail && out.code !== 0) throw new Error(`podman ${args.join(' ')} exited ${out.code}: ${redactText(out.stderr.trim()).slice(-2000)}`);
	return out;
};

// `podman compose` by default; NOTESTEAD_COMPOSE may name another provider command (for example `docker compose`).
const composeCommand = (): string[] => (process.env.NOTESTEAD_COMPOSE ?? 'podman compose').split(' ').filter(p => p !== '');

export const knownSecrets = (state: StackState): KnownSecret[] => state.accounts.flatMap((a, i) => [
	{ label: `account${i}_password`, value: a.password },
	{ label: `account${i}_master_password`, value: a.masterPassword },
]);

const composeEnv = (state: StackState, extra: Record<string, string>): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// The variables of the user's own shell never reach the compose files: only NST_* are interpolated, all set here.
	for (const key of Object.keys(env)) if (key.startsWith('NST_')) delete env[key];
	return {
		...env,
		NST_PROJECT: state.project,
		NST_RUN: state.run,
		NST_PUBLIC_URL: publicUrl,
		NST_SERVER_IMAGE: state.images.server,
		NST_WEB_IMAGE: state.images.web,
		NST_HEADLESS_IMAGE: state.images.headless,
		NST_BACK_NETWORK: state.backNetwork,
		...extra,
	};
};

let composeCounter = 0;

const composeArgs = (project: string, files: string[], args: string[]): string[] => {
	const [cmd, ...pre] = composeCommand();
	return [cmd, ...pre, '-p', project, ...files.flatMap(f => ['-f', f]), ...args];
};

const writeComposeLog = (state: StackState, label: string, argv: string[], code: number | null, output: string): string => {
	mkdirSync(state.logsDir, { recursive: true });
	const log = join(state.logsDir, `compose-${String(++composeCounter).padStart(2, '0')}-${label}.log`);
	writeFileSync(log, redactText(`$ ${argv.join(' ')}\n# exit ${code}\n${output}`, knownSecrets(state)));
	return log;
};

const composeSync = (state: StackState, label: string, project: string, files: string[], args: string[], extra: Record<string, string> = {}, timeoutMs = 10 * 60_000): { code: number | null; output: string; log: string } => {
	const argv = composeArgs(project, files, args);
	const r = spawnSync(argv[0], argv.slice(1), { cwd: stackDir(), env: composeEnv(state, extra), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	const output = `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}` : ''}`;
	return { code: r.status, output, log: writeComposeLog(state, label, argv, r.status, output) };
};

// Runs `compose up -d …` in the background while the health of the project's containers is polled: a service that
// turns unhealthy or exits aborts at once (podman-compose would otherwise wait on it for ever).
const composeUp = async (state: StackState, label: string, project: string, files: string[], services: string[], extra: Record<string, string>, timeoutMs: number): Promise<Record<string, string>> => {
	const argv = composeArgs(project, files, ['up', '-d', ...services]);
	const child = spawn(argv[0], argv.slice(1), { cwd: stackDir(), env: composeEnv(state, extra), stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', (c: Buffer) => {
		output += c.toString('utf8');
	});
	child.stderr.on('data', (c: Buffer) => {
		output += c.toString('utf8');
	});
	let exitCode: number | null | undefined;
	const exited = new Promise<void>(resolve => child.on('close', code => {
		exitCode = code;
		resolve();
	}));
	let fatal: StackHealthError | undefined;
	try {
		return await waitFor(`${services.join(', ')} of ${project} to be healthy`, async () => {
			const containers = projectContainers(project);
			const health = healthOf(services, containers);
			return exitCode === 0 && health.every(h => h.status === 'healthy') ? containers : undefined;
		}, {
			timeoutMs,
			intervalMs: 1_000,
			// An unhealthy, exited or unchecked service, or a failed `compose up`, ends the wait at once.
			failFast: () => {
				if (exitCode !== undefined && exitCode !== 0) {
					fatal = new StackHealthError(services.join(','), `\`${argv.join(' ')}\` exited ${exitCode}:\n${redactText(output).slice(-3000)}`);
				} else {
					const sick = healthOf(services, projectContainers(project)).find(h => h.status === 'unhealthy' || h.status === 'exited' || h.status === 'no healthcheck');
					if (sick) fatal = new StackHealthError(sick.service, describeSick(sick));
				}
				return fatal?.message;
			},
		});
	} catch (error) {
		if (fatal) throw fatal;
		// A timeout: name every service that is not healthy.
		const pending = healthOf(services, projectContainers(project)).filter(h => h.status !== 'healthy');
		throw new StackHealthError(pending.map(h => h.service).join(',') || services.join(','),
			`stack services not healthy within ${timeoutMs / 1000} s: ${pending.map(describeSick).join('; ') || (error as Error).message}`);
	} finally {
		if (exitCode === undefined) child.kill('SIGTERM');
		await exited;
		writeComposeLog(state, label, argv, exitCode ?? null, output);
	}
};

// service name → container name, for one compose project.
export const projectContainers = (project: string): Record<string, string> => {
	const r = podmanSync(['ps', '-a', '--filter', `label=${projectLabel}=${project}`, '--format', '{{.Names}}\t{{index .Labels "com.docker.compose.service"}}'], { allowFail: true });
	const map: Record<string, string> = {};
	for (const line of r.stdout.split('\n').filter(l => l.trim() !== '')) {
		const [name, service] = line.split('\t');
		if (service) map[service] = name;
	}
	return map;
};

interface Health {
	service: string;
	container?: string;
	status: string;
	check?: string;
	lastOutput?: string;
}

const describeSick = (h: Health): string => {
	if (!h.container) return `stack service "${h.service}" has no container`;
	return `stack service "${h.service}" (container ${h.container}) is ${h.status}${h.check ? `; healthcheck: ${h.check}` : ''}${h.lastOutput !== undefined ? `; last check output: ${JSON.stringify(redactText(h.lastOutput).slice(-500))}` : ''}`;
};

export const healthOf = (services: string[], containers: Record<string, string>): Health[] => services.map(service => {
	const container = containers[service];
	if (!container) return { service, status: 'not created' };
	const r = podmanSync(['inspect', '--format', '{{json .State}}\t{{json .Config.Healthcheck}}', container], { allowFail: true });
	if (r.code !== 0) return { service, container, status: 'not created' };
	const [stateJson, checkJson] = r.stdout.trim().split('\t');
	const state = JSON.parse(stateJson) as { Status?: string; Health?: { Status?: string; Log?: { Output?: string }[] } };
	const check = JSON.parse(checkJson || 'null') as { Test?: string[] } | null;
	const checkText = check?.Test?.join(' ');
	if (state.Status !== 'running') return { service, container, status: 'exited', check: checkText };
	if (!check?.Test || check.Test.length === 0 || check.Test[0] === 'NONE') return { service, container, status: 'no healthcheck' };
	const log = state.Health?.Log ?? [];
	return { service, container, status: state.Health?.Status || 'starting', check: checkText, lastOutput: log.length > 0 ? log[log.length - 1].Output ?? '' : undefined };
});

export const hostPortOf = (container: string, port: number): number => {
	const line = podmanSync(['port', container, `${port}/tcp`]).stdout.trim().split('\n')[0] ?? '';
	const value = Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`no published host port for ${container}:${port} (podman port said ${JSON.stringify(line)})`);
	return value;
};

// ---- Lifecycle ----

const descriptorDir = (): string => join(tmpdir(), 'notestead-stacks');
const descriptorPath = (project: string): string => join(descriptorDir(), `${project}.json`);

export const saveDescriptor = (state: StackState): void => {
	mkdirSync(descriptorDir(), { recursive: true, mode: 0o700 });
	writeFileSync(descriptorPath(state.project), JSON.stringify(state), { mode: 0o600 });
};

// A stack another harness process started (JOPLIN_SERVER_URL named its server): used, never torn down here.
export const attachStack = (server: HarnessServer): StackState => {
	const file = descriptorPath(server.project);
	if (!existsSync(file)) throw new Error(`JOPLIN_SERVER_URL names the harness server ${server.container}, but its stack descriptor ${file} is missing; restart the stack with \`node tests/stack/cli.ts up\``);
	return { ...JSON.parse(readFileSync(file, 'utf8')) as StackState, owned: false, attached: true };
};

export interface NewStackOptions {
	name?: string;
	logsDir?: string;
	// extra compose files layered over compose.yaml (paths relative to tests/stack/ or absolute); the M1-AC18 NEG
	// uses compose.neg-web-health.yaml. NOTESTEAD_STACK_OVERRIDES (comma-separated) adds more.
	overrides?: string[];
	images?: StackImages;
}

// Runs the guard first: with JOPLIN_SERVER_URL set, this either attaches to the stack that owns that server or throws.
export const newStack = (opts: NewStackOptions = {}): StackState => {
	const match = checkServerUrl(process.env.JOPLIN_SERVER_URL);
	if (match) return attachStack(match);
	const run = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
	const project = `nst-${opts.name ?? 'stack'}-${run}`;
	const logsDir = opts.logsDir ?? join(findRepoRoot(), 'test-results', 'stack', project);
	const workDir = mkdtempSync(join(tmpdir(), 'nst-stack-'));
	const envOverrides = (process.env.NOTESTEAD_STACK_OVERRIDES ?? '').split(',').map(s => s.trim()).filter(s => s !== '');
	return {
		project,
		run,
		owned: true,
		overrides: [...(opts.overrides ?? []), ...envOverrides],
		images: opts.images ?? resolveImages(workDir, logsDir),
		workDir,
		logsDir,
		frontNetwork: `${project}-front`,
		backNetwork: `${project}-back`,
		containers: {},
		accounts: [],
		headless: [],
	};
};

const coreFiles = (state: StackState): string[] => ['compose.yaml', ...state.overrides];

// server and web up and healthy; the server seeded with createTestUsers (admin@localhost / admin).
export const upCore = async (state: StackState, timeoutMs = 10 * 60_000): Promise<void> => {
	const containers = await composeUp(state, 'up-core', state.project, coreFiles(state), [...coreServices], {}, timeoutMs);
	state.containers = { server: containers.server, web: containers.web };
	state.serverUrl = `http://127.0.0.1:${hostPortOf(containers.server, 22300)}`;
	state.webUrl = `http://127.0.0.1:${hostPortOf(containers.web, 8080)}`;
	const seeded = await serverRequest(state, '/api/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'createTestUsers' }) });
	if (seeded.status !== 200) throw new Error(`createTestUsers returned ${seeded.status}: ${seeded.text.slice(0, 300)}`);
	saveDescriptor(state);
};

// Requests to this stack's server only (its published port, with the Host its APP_BASE_URL expects).
export const serverRequest = (state: StackState, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> => {
	if (!state.serverUrl) throw new Error('the stack server is not up');
	const port = Number.parseInt(new URL(state.serverUrl).port, 10);
	return request({ port, path, method: opts.method, headers: { Host: publicHost, ...(opts.headers ?? {}) }, body: opts.body });
};

// Requests through this stack's `web` container (127.0.0.1:<published 8080>).
export const webRequest = (state: StackState, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> => {
	if (!state.webUrl) throw new Error('the stack web container is not up');
	return request({ port: Number.parseInt(new URL(state.webUrl).port, 10), path, method: opts.method, headers: opts.headers, body: opts.body });
};

const json = (text: string): Record<string, unknown> => {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return {};
	}
};

export const sessionFor = async (state: StackState, email: string, password: string): Promise<string> => {
	const res = await serverRequest(state, '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
	const id = json(res.text).id;
	if (res.status !== 200 || typeof id !== 'string') throw new Error(`login of ${email} returned ${res.status}: ${res.text.slice(0, 300)}`);
	return id;
};

// Passwords with a space, a non-ASCII letter, `$` and `!`, but no quote, backslash or newline (the device's batch
// file quotes the master password).
const strongPassword = (label: string): string => `nst${label}${randomBytes(12).toString('hex')} Δ$x!`;

// A fresh user per test (ADR-0007), through the admin API.
export const createAccount = async (state: StackState): Promise<Account> => {
	const admin = await sessionFor(state, 'admin@localhost', 'admin');
	const email = `nst-${randomBytes(6).toString('hex')}@example.com`;
	const created = await serverRequest(state, '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-AUTH': admin }, body: JSON.stringify({ email, full_name: 'Notestead test user' }) });
	const id = json(created.text).id;
	if (created.status !== 200 || typeof id !== 'string') throw new Error(`POST /api/users returned ${created.status}: ${created.text.slice(0, 300)}`);
	const account: Account = { email, password: strongPassword('pw'), masterPassword: strongPassword('mp') };
	state.accounts.push(account);
	const patched = await serverRequest(state, `/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-API-AUTH': admin }, body: JSON.stringify({ password: account.password, must_set_password: 0 }) });
	if (patched.status !== 200 && patched.status !== 204) throw new Error(`PATCH /api/users/${id} returned ${patched.status}: ${patched.text.slice(0, 300)}`);
	await sessionFor(state, email, account.password);
	if (state.owned) saveDescriptor(state);
	return account;
};

// The CLI "other device" (tests/fixtures/m1-s5/device): joins the account through web's public proxy, turns E2EE on,
// seeds a folder and notes, syncs. Everything secret travels on stdin.
export const enableE2ee = (state: StackState, account: Account, label: string): Account => {
	const tag = randomBytes(5).toString('hex');
	const folder = `Notestead folder ${tag}`;
	const notes = [{ title: `Notestead note ${tag}`, body: `Seeded body ${tag} zebracorn` }];
	const name = `${state.project}-device-${label}`;
	const r = spawnSync('podman', ['run', '--rm', '-i', '--name', name, '--network', state.frontNetwork,
		'--label', `${testLabel}=stack`, '--label', `${runLabel}=${state.run}`, state.images.device], {
		input: JSON.stringify({ syncUrl: 'http://web:8080/joplin-server', email: account.email, password: account.password, masterPassword: account.masterPassword, folder, notes }),
		encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
	});
	mkdirSync(state.logsDir, { recursive: true });
	writeFileSync(join(state.logsDir, `device-${label}.log`), redactText(`# exit ${r.status}\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`, knownSecrets(state)));
	const line = (r.stdout ?? '').split('\n').filter(l => l.startsWith('RESULT ')).pop();
	if (r.status !== 0 || !line) throw new Error(`the E2EE device failed (exit ${r.status}; log ${join(state.logsDir, `device-${label}.log`)}): ${redactText(`${r.stdout}\n${r.stderr}`, knownSecrets(state)).slice(-1500)}`);
	const result = JSON.parse(line.slice('RESULT '.length)) as { e2ee: string; notes: { id: string; title: string }[] };
	account.e2ee = result.e2ee;
	account.folder = folder;
	account.notes = result.notes.map(n => ({ ...n, body: notes.find(s => s.title === n.title)?.body ?? '' }));
	if (state.owned) saveDescriptor(state);
	return account;
};

// One compose project (compose.headless.yaml) for `account`, healthy (its /healthz is 200: initial sync and decryption
// done). Secrets are files in a 0700 dir, mounted by compose as /run/secrets/*.
export const upHeadless = async (state: StackState, account: Account, label: string, timeoutMs = 10 * 60_000): Promise<HeadlessService> => {
	const project = `${state.project}-hl-${label}`;
	const secretsDir = join(state.workDir, `secrets-${label}`);
	mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(secretsDir, 'joplin_password'), `${account.password}\n`, { mode: 0o444 });
	writeFileSync(join(secretsDir, 'e2ee_master_password'), account.masterPassword, { mode: 0o444 });
	chmodSync(secretsDir, 0o755); // the headless user (uid 1000 in the container) reads the bind-mounted files
	const service: HeadlessService = { label, project, container: '', secretsDir, email: account.email };
	state.headless.push(service);
	const containers = await composeUp(state, `up-headless-${label}`, project, ['compose.headless.yaml'], ['headless'],
		{ NST_JOPLIN_USERNAME: account.email, NST_SECRETS_DIR: secretsDir }, timeoutMs);
	service.container = containers.headless;
	if (state.owned) saveDescriptor(state);
	return service;
};

// The default E2EE account and its headless service: the whole stack is healthy before any test starts (M1-AC18).
export const upDefault = async (state: StackState): Promise<void> => {
	state.defaultAccount = enableE2ee(state, await createAccount(state), 'default');
	state.defaultHeadless = await upHeadless(state, state.defaultAccount, 'default');
	if (state.owned) saveDescriptor(state);
};

// The Data API token of a running headless container (read from its profile, never printed), for redaction.
export const dataApiToken = (container: string): string | undefined => {
	const r = podmanSync(['exec', container, 'node', '-e', "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/data/profile/settings.json','utf8'))['api.token']||''))"], { allowFail: true });
	return r.code === 0 && r.stdout.length >= 16 ? r.stdout : undefined;
};

export const secretsFor = (state: StackState): KnownSecret[] => {
	const secrets = knownSecrets(state);
	for (const hs of state.headless) {
		const token = hs.container ? dataApiToken(hs.container) : undefined;
		if (token) secrets.push({ label: `data_api_token_${hs.label}`, value: token });
	}
	return secrets;
};

// A container's log, redacted (token=, credential headers, every secret the stack knows). `since`: ISO time.
export const containerLog = (state: StackState, container: string, since?: string, secrets: KnownSecret[] = secretsFor(state)): string => {
	const r = podmanSync(['logs', ...(since ? ['--since', since] : []), container], { allowFail: true });
	return redactText(`${r.stdout}${r.stderr}`, secrets);
};

const composeDown = (state: StackState, label: string, project: string, files: string[], extra: Record<string, string>): void => {
	composeSync(state, label, project, files, ['down', '-v', '-t', '0'], extra, 5 * 60_000);
};

export const downHeadless = (state: StackState, service: HeadlessService | undefined): void => {
	if (!service) return;
	const secrets = secretsFor(state);
	if (service.container) writeFileSync(join(state.logsDir, `${service.container}.log`), containerLog(state, service.container, undefined, secrets));
	composeDown(state, `down-headless-${service.label}`, service.project, ['compose.headless.yaml'], { NST_JOPLIN_USERNAME: service.email, NST_SECRETS_DIR: service.secretsDir });
	rmSync(service.secretsDir, { recursive: true, force: true });
	state.headless = state.headless.filter(h => h !== service);
	if (state.owned) saveDescriptor(state);
};

// Everything this stack's run labelled (containers, networks, volumes): the safety net after `compose down`.
export const sweepRun = (run: string): void => {
	const filter = `label=${runLabel}=${run}`;
	const list = (args: string[]): string[] => podmanSync(args, { allowFail: true }).stdout.split('\n').filter(n => n.trim() !== '');
	const containers = list(['ps', '-a', '--filter', filter, '--format', '{{.Names}}']);
	if (containers.length > 0) podmanSync(['rm', '-f', '-t', '0', ...containers], { allowFail: true });
	const volumes = list(['volume', 'ls', '--filter', filter, '--format', '{{.Name}}']);
	if (volumes.length > 0) podmanSync(['volume', 'rm', '-f', ...volumes], { allowFail: true });
	const networks = list(['network', 'ls', '--filter', filter, '--format', '{{.Name}}']);
	if (networks.length > 0) podmanSync(['network', 'rm', '-f', ...networks], { allowFail: true });
};

export const writeLogs = (state: StackState): void => {
	mkdirSync(state.logsDir, { recursive: true });
	const secrets = secretsFor(state);
	for (const container of [...Object.values(state.containers), ...state.headless.map(h => h.container)]) {
		if (container) writeFileSync(join(state.logsDir, `${container}.log`), containerLog(state, container, undefined, secrets));
	}
};

// Safe on a partly started stack. A stack attached through JOPLIN_SERVER_URL is left running for its owner.
export const downStack = (state: StackState | undefined): void => {
	if (!state || !state.owned) return;
	try {
		writeLogs(state);
	} finally {
		for (const service of [...state.headless]) downHeadless(state, service);
		composeDown(state, 'down-core', state.project, coreFiles(state), {});
		sweepRun(state.run);
		rmSync(state.workDir, { recursive: true, force: true });
		rmSync(descriptorPath(state.project), { force: true });
		removeBuiltImages(state.images);
	}
};

// ---- Leftover checks (M1-AC18) ----

export interface PodmanSnapshot {
	containers: string[];
	networks: string[];
	volumes: string[];
	pods: string[];
}

export const snapshot = (): PodmanSnapshot => {
	const list = (args: string[]): string[] => podmanSync(args).stdout.split('\n').map(l => l.trim()).filter(l => l !== '').sort();
	return {
		containers: list(['ps', '-a', '--format', '{{.Names}}']),
		networks: list(['network', 'ls', '--format', '{{.Name}}']),
		volumes: list(['volume', 'ls', '--format', '{{.Name}}']),
		pods: list(['pod', 'ls', '--format', '{{.Name}}']),
	};
};

// Container names of a role in a stack (label io.github.thescriptingguy.notestead.stack-role).
export const roleContainers = (run: string, role: string): string[] => podmanSync(['ps', '-a', '--filter', `label=${runLabel}=${run}`, '--filter', `label=${roleLabel}=${role}`, '--format', '{{.Names}}'])
	.stdout.split('\n').filter(n => n.trim() !== '');
