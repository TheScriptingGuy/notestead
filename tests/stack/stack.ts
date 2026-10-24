// The compose test stack (docs/test-plans/M1-S6.md §Compose test stack; ADR-0006, ADR-0007). One API for every runner:
// the Playwright globalSetup and fixtures (tests/e2e/support), the M1-S6 contract self-tests and the developer CLI
// (tests/stack/cli.ts). Shared by Jest (CommonJS) and Playwright/Node (ESM): no __dirname, no import.meta.
// Lifecycle:
//   newStack()      guard (M1-AC19), names, work dir, descriptor saved (M1-S8 C4-R3); nothing started yet
//   upCore()        `podman compose up -d server web`; every service must reach `healthy` (M1-AC18), else abort naming it
//   createAccount() a fresh user through the admin API (strong unique password)
//   enableE2ee()    the CLI "other device" turns E2EE on for that account and seeds notes (ADR-0007 `e2eeAccount`)
//   upHeadless()    one compose project per account (compose.headless.yaml), on the stack's `back` network, healthy
//   downStack()     logs written (redacted), every compose project down with volumes, the run's labels swept, the
//                   work dir and the images this process built removed
// The JOPLIN_SERVER_URL guard runs before anything else, and every request to the server goes through `serverRequest`,
// which only accepts this stack's own published port.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../contract/support/http.ts';
import type { HttpResponse } from '../contract/support/http.ts';
import { waitFor } from '../support/poll.ts';
import { redactText } from '../support/redact.ts';
import type { KnownSecret } from '../support/redact.ts';
import { findRepoRoot } from '../support/repoRoot.ts';
import { registerSecrets } from '../support/secrets.ts';
import { descriptorDir, descriptorPath, ensureDescriptorDir, readDescriptorFile } from './descriptors.ts';
import { checkServerUrl, projectLabel, roleLabel, runLabel, testLabel } from './guard.ts';
import type { HarnessServer } from './guard.ts';
import { removeBuiltImages, resolveImages } from './images.ts';
import type { StackImages } from './images.ts';
import { checkSeededInfo } from './seedCheck.ts';

export const stackDir = (): string => join(findRepoRoot(), 'tests', 'stack');
export const coreServices = ['server', 'web'] as const;
export const publicHost = 'joplin.example.test';
export const publicUrl = `https://${publicHost}`;

// The seeded to-do's due date (epoch ms): fixed and in the future (M2-S2 D7).
export const seedTodoDue = Date.UTC(2031, 0, 15, 8, 30);

export interface Account {
	email: string;
	password: string;
	masterPassword: string;
	e2ee?: string;
	// the random tag in the titles and bodies the E2EE device seeded (enableE2ee)
	seedTag?: string;
	folder?: string;
	notes?: { id: string; title: string; body: string }[];
	// the seed extras (enableE2ee with extras: true; M2-S2 D7): a to-do with todo_due, a tag on note 1, and a text
	// attachment on a note of its own, with the sha256 and byte size of the attached file
	seedTodo?: { id: string; title: string; due: number };
	seedTagTitle?: string;
	seedAttachment?: { noteId: string; noteTitle: string; fileName: string; sha256: string; size: number };
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
	// the process that started the stack; while it is alive, the contract sweep keeps the stack (M1-S6a C4)
	ownerPid?: number;
	// a developer's stack (`cli.ts up`): it outlives ownerPid, and only `cli.ts down` removes it (M1-S6a C4)
	persistent?: boolean;
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

export const accountSecrets = (account: Account): KnownSecret[] => [
	{ label: 'account_password', value: account.password },
	{ label: 'master_password', value: account.masterPassword },
];

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

export { descriptorDir, descriptorPath };

// The directory is checked (and created 0700) first; the file is written 0600 (M1-S8 C5).
export const saveDescriptor = (state: StackState): void => {
	ensureDescriptorDir(true);
	const file = descriptorPath(state.project);
	writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
	chmodSync(file, 0o600);
};

// A stack another harness process started (JOPLIN_SERVER_URL named its server): used, never torn down here.
export const attachStack = (server: HarnessServer): StackState => {
	const file = descriptorPath(server.project);
	if (!existsSync(file)) throw new Error(`JOPLIN_SERVER_URL names the harness server ${server.container}, but its stack descriptor ${file} is missing; restart the stack with \`node tests/stack/cli.ts up\``);
	return { ...JSON.parse(readDescriptorFile(file)) as StackState, owned: false, attached: true };
};

export interface NewStackOptions {
	name?: string;
	logsDir?: string;
	// extra compose files layered over compose.yaml (paths relative to tests/stack/ or absolute); the M1-AC18 NEG
	// uses compose.neg-web-health.yaml. NOTESTEAD_STACK_OVERRIDES (comma-separated) adds more.
	overrides?: string[];
	images?: StackImages;
	// `cli.ts up`: the stack outlives this process (M1-S6a C4)
	persistent?: boolean;
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
	const state: StackState = {
		project,
		run,
		owned: true,
		ownerPid: process.pid,
		...(opts.persistent ? { persistent: true } : {}),
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
	// Saved before anything starts (M1-S8 C4-R3): a concurrent contract sweep keeps a stack that is still starting.
	saveDescriptor(state);
	return state;
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
	// Known to every redaction (worker stdio, the redacting reporter) before anything can print it (M1-S6a C1).
	registerSecrets(accountSecrets(account));
	state.accounts.push(account);
	const patched = await serverRequest(state, `/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-API-AUTH': admin }, body: JSON.stringify({ password: account.password, must_set_password: 0 }) });
	if (patched.status !== 200 && patched.status !== 204) throw new Error(`PATCH /api/users/${id} returned ${patched.status}: ${patched.text.slice(0, 300)}`);
	await sessionFor(state, email, account.password);
	if (state.owned) saveDescriptor(state);
	return account;
};

// The CLI "other device" (tests/fixtures/m1-s5/device): joins the account through web's public proxy, turns E2EE on,
// seeds a folder and notes, syncs. Everything secret travels on stdin.
// `seed.notes` notes (default 1): the first has the title and body of the single-note seed of M1; note i (2 and up) has
// a title that is not a prefix of another and a body with non-ASCII text (M2-S1).
// `seed.extras` (M2-S2 D7): the device also seeds a to-do `Notestead todo <tag>` with todo_due = seedTodoDue, the tag
// `nst-seed-<tag>` on note 1, and a note `Notestead attachment note <tag>` with a text attachment `nst-seed-<tag>.txt`.
export interface SeedOptions { notes?: number; extras?: boolean }

export const enableE2ee = async (state: StackState, account: Account, label: string, seed: SeedOptions = {}): Promise<Account> => {
	const tag = randomBytes(5).toString('hex');
	const folder = `Notestead folder ${tag}`;
	const notes = [{ title: `Notestead note ${tag}`, body: `Seeded body ${tag} zebracorn` }];
	for (let i = 2; i <= (seed.notes ?? 1); i++) notes.push({ title: `Notestead note ${i} ${tag}`, body: `Seeded body ${i} ${tag} zebracorn Δ ✓ ünïcödé` });
	const text = `Notestead seeded attachment ${tag}\n`.repeat(64);
	const extras = seed.extras ? {
		todo: { title: `Notestead todo ${tag}`, due: seedTodoDue },
		tag: { title: `nst-seed-${tag}`, note: notes[0].title },
		attachment: { note: `Notestead attachment note ${tag}`, fileName: `nst-seed-${tag}.txt`, contentBase64: Buffer.from(text, 'utf8').toString('base64') },
	} : undefined;
	const name = `${state.project}-device-${label}`;
	const r = spawnSync('podman', ['run', '--rm', '-i', '--name', name, '--network', state.frontNetwork,
		'--label', `${testLabel}=stack`, '--label', `${runLabel}=${state.run}`, state.images.device], {
		input: JSON.stringify({ syncUrl: 'http://web:8080/joplin-server', email: account.email, password: account.password, masterPassword: account.masterPassword, folder, notes, ...(extras ? { extras } : {}) }),
		encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
	});
	mkdirSync(state.logsDir, { recursive: true });
	writeFileSync(join(state.logsDir, `device-${label}.log`), redactText(`# exit ${r.status}\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`, knownSecrets(state)));
	const line = (r.stdout ?? '').split('\n').filter(l => l.startsWith('RESULT ')).pop();
	if (r.status !== 0 || !line) throw new Error(`the E2EE device failed (exit ${r.status}; log ${join(state.logsDir, `device-${label}.log`)}): ${redactText(`${r.stdout}\n${r.stderr}`, knownSecrets(state)).slice(-1500)}`);
	// The post-condition (DNS-1, DNS1-AC4), on the server itself: the seed uploaded a master key. The device fails on a
	// reported sync error; this catches an upload that failed without being reported.
	const info = await serverItemContent(state, account, 'info.json');
	const reason = checkSeededInfo(info.status, info.text);
	if (reason) throw new Error(`the E2EE device did not seed the account: ${reason} (log ${join(state.logsDir, `device-${label}.log`)})`);
	const result = JSON.parse(line.slice('RESULT '.length)) as { e2ee: string; notes: { id: string; title: string }[]; todo?: { id: string }; attachmentNote?: { id: string } };
	account.e2ee = result.e2ee;
	account.seedTag = tag;
	account.folder = folder;
	account.notes = result.notes.map(n => ({ ...n, body: notes.find(s => s.title === n.title)?.body ?? '' }));
	if (extras) {
		if (!result.todo || !result.attachmentNote) throw new Error(`the E2EE device did not report the seeded to-do and attachment note (log ${join(state.logsDir, `device-${label}.log`)})`);
		account.seedTodo = { id: result.todo.id, title: extras.todo.title, due: extras.todo.due };
		account.seedTagTitle = extras.tag.title;
		account.seedAttachment = {
			noteId: result.attachmentNote.id, noteTitle: extras.attachment.note, fileName: extras.attachment.fileName,
			sha256: createHash('sha256').update(text, 'utf8').digest('hex'), size: Buffer.byteLength(text),
		};
	}
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
	registerToken(service);
	if (state.owned) saveDescriptor(state);
	return service;
};

// The default E2EE account and its headless service: the whole stack is healthy before any test starts (M1-AC18).
export const upDefault = async (state: StackState): Promise<void> => {
	state.defaultAccount = await enableE2ee(state, await createAccount(state), 'default');
	state.defaultHeadless = await upHeadless(state, state.defaultAccount, 'default');
	if (state.owned) saveDescriptor(state);
};

// The Data API token of a running headless container (read from its profile, never printed), for redaction.
export const dataApiToken = (container: string): string | undefined => {
	const r = podmanSync(['exec', container, 'node', '-e', "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/data/profile/settings.json','utf8'))['api.token']||''))"], { allowFail: true });
	return r.code === 0 && r.stdout.length >= 16 ? r.stdout : undefined;
};

// Registers the service's current Data API token (the CLI rotates it on every start, M1-S5), for redaction (M1-S6a C1).
export const registerToken = (service: HeadlessService): void => {
	const token = service.container ? dataApiToken(service.container) : undefined;
	if (token) registerSecrets([{ label: `data_api_token_${service.label}`, value: token }]);
};

// The supervisor's own health report, read inside the container (8090 is never published).
export const headlessHealthz = (container: string): { status: number; state?: string; lastSync?: string } | undefined => {
	const r = podmanSync(['exec', container, 'node', '-e', "fetch('http://127.0.0.1:8090/healthz').then(async r=>process.stdout.write(JSON.stringify({status:r.status,...JSON.parse(await r.text())})),()=>process.exit(1))"], { allowFail: true });
	if (r.code !== 0) return undefined;
	try {
		return JSON.parse(r.stdout) as { status: number; state?: string; lastSync?: string };
	} catch {
		return undefined;
	}
};

// One headless sync (M1-AC21 step 2; docs/test-plans/M1-S7.md Interpretation 2). The M1 supervisor syncs in its start
// cycle only (packages/headless/README.md: `config --import`, `sync`, `e2ee decrypt --force`, `server start`), so one
// sync is one restart of the service: SIGTERM stops the CLI children (the supervisor exits 0), the init and the
// supervisor start again on the same profile volume, and the service is done when it is `healthy` again with a
// `lastSync` later than the restart. The CLI rotates the Data API token on every start: the new one is registered
// for redaction at once (review M1-S6a-r1 C1-R6). M3 (`requestSync('manual')`) can replace the restart with the
// supervisor's own trigger without changing callers.
export const syncHeadlessOnce = async (state: StackState, service: HeadlessService, timeoutMs = 10 * 60_000): Promise<{ lastSync: string; durationMs: number }> => {
	const started = Date.now();
	podmanSync(['restart', '-t', '30', service.container], { timeoutMs: 2 * 60_000 });
	const lastSync = await waitFor(`${service.container} to sync once more (healthy again, lastSync after the restart)`, async () => {
		const [health] = healthOf(['headless'], { headless: service.container });
		if (health.status !== 'healthy') return undefined;
		const report = headlessHealthz(service.container);
		return report?.status === 200 && report.lastSync && Date.parse(report.lastSync) > started ? report.lastSync : undefined;
	}, {
		timeoutMs,
		intervalMs: 1_000,
		failFast: () => {
			const [health] = healthOf(['headless'], { headless: service.container });
			return health.status === 'exited' || health.status === 'unhealthy' ? describeSick(health) : undefined;
		},
	});
	registerToken(service);
	if (state.owned) saveDescriptor(state);
	return { lastSync, durationMs: Date.now() - started };
};

// A free TCP port on 127.0.0.1 (released before it is returned: the caller binds it at once).
export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
	const server = createServer();
	server.once('error', reject);
	server.listen(0, '127.0.0.1', () => {
		const address = server.address();
		server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
	});
});

export interface ExtraWeb {
	container: string;
	url: string;
	host: string;
}

// A second `web` container of the image under test, on the stack's `front` network, whose proxy sends the browser's
// own Host (127.0.0.1:<its published port>) to the server: exactly what the server receives when the proxy's Host
// rewrite (ADR-0002 rule 1, `header_up Host`) is disabled, because Caddy then passes the incoming Host through. It uses
// the shipped image and its documented JOPLIN_SERVER_HOST override (no product switch; M1-S4 `ac10-c1-neg` proved the
// override wins over the default). Hardened like compose.yaml's `web`; labelled with the run, so the sweep removes it.
// M1-AC21 NEG (docs/test-plans/M1-S7.md).
export const upWebWithoutHostRewrite = async (state: StackState, label: string): Promise<ExtraWeb> => {
	const port = await freePort();
	const host = `127.0.0.1:${port}`;
	const container = `${state.project}-web-nohost-${label}`;
	podmanSync(['run', '-d', '--name', container, '--network', state.frontNetwork,
		'--label', `${testLabel}=stack`, '--label', `${runLabel}=${state.run}`, '--label', `${roleLabel}=web-without-host-rewrite`,
		'--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m',
		'-p', `${host}:8080`,
		'-e', 'JOPLIN_SERVER_URL=http://server:22300', '-e', `JOPLIN_SERVER_PUBLIC_URL=${publicUrl}`, '-e', `JOPLIN_SERVER_HOST=${host}`,
		state.images.web]);
	await waitFor(`${container} to serve the bundle`, async () => {
		const res = await request({ port, path: '/' });
		return res.status === 200 ? true : undefined;
	}, {
		timeoutMs: 60_000,
		failFast: () => (podmanSync(['inspect', '--format', '{{.State.Status}}', container], { allowFail: true }).stdout.trim() === 'running' ? undefined : `${container} is not running: ${containerLog(state, container).slice(-1500)}`),
	});
	return { container, url: `http://${host}`, host };
};

export const removeContainer = (state: StackState, container: string): void => {
	mkdirSync(state.logsDir, { recursive: true });
	writeFileSync(join(state.logsDir, `${container}.log`), containerLog(state, container));
	podmanSync(['rm', '-f', '-t', '0', container], { allowFail: true });
};

// The server's view of an account (data-level assertions): its item names (`<id>.md`, `.resource/<id>`, info.json …)
// and an item's serialized content, through the server's own API (this stack's published port only).
export const serverItemNames = async (state: StackState, account: Account): Promise<string[]> => {
	const session = await sessionFor(state, account.email, account.password);
	const names: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 100; page++) {
		const res = await serverRequest(state, `/api/items/root:/:/children${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { 'X-API-AUTH': session } });
		if (res.status !== 200) throw new Error(`GET /api/items/root:/:/children returned ${res.status}: ${res.text.slice(0, 300)}`);
		const body = json(res.text) as unknown as { items?: { name: string }[]; has_more?: boolean; cursor?: string };
		names.push(...(body.items ?? []).map(i => i.name));
		if (!body.has_more || !body.cursor) return names.sort();
		cursor = body.cursor;
	}
	throw new Error('more than 100 pages of items');
};

export const serverItemContent = async (state: StackState, account: Account, name: string): Promise<{ status: number; text: string }> => {
	const session = await sessionFor(state, account.email, account.password);
	const res = await serverRequest(state, `/api/items/root:/${name}:/content`, { headers: { 'X-API-AUTH': session } });
	return { status: res.status, text: res.text };
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
