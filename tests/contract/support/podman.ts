// Podman helpers for the contract layer (ADR-0007): one labelled network per suite with a free fixed /24 subnet, so
// every container gets a fixed address (the cloudflared stand-in must sit at a known one, ADR-0002 rule 4); unique
// container names; published ports on 127.0.0.1 picked by podman; logs written (redacted) for every container at
// teardown; everything the run labelled is removed. Polling helpers wait for conditions, never for fixed times.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '../../support/poll.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';

export { waitFor };
// Found from the working directory, not __dirname: these helpers are shared with the Playwright harness (ESM, M1-S6).
export const repoRoot = findRepoRoot();
export const testLabel = 'io.github.thescriptingguy.notestead.test';
export const runLabel = 'io.github.thescriptingguy.notestead.test-run';
// Client and echo fixtures run on the official Node image (multi-arch), never on the image under test.
export const nodeImage = 'docker.io/library/node:22-bookworm-slim';
export const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'm1-s4');

export interface Pin {
	server: { image: string; tag: string };
}

export const readPin = (): Pin => JSON.parse(readFileSync(join(repoRoot, 'upstream', 'joplin-version.json'), 'utf8')) as Pin;

export const redact = (s: string): string => s
	.replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]')
	.replace(/(X-API-AUTH["']?\s*[:=]\s*\[?["']?)[^"'\s,\]]+/gi, '$1[REDACTED]');

export interface PodmanResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export const podman = (args: string[], { allowFail = false, timeoutMs = 5 * 60_000 } = {}): PodmanResult => {
	const r = spawnSync('podman', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	const result = { code: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}` : ''}` };
	if (!allowFail && result.code !== 0) {
		throw new Error(`podman ${args.join(' ')} exited ${result.code}: ${redact(result.stderr.trim()).slice(-2000)}`);
	}
	return result;
};

export const runId = (): string => process.env.NOTESTEAD_CONTRACT_RUN ?? `adhoc${process.pid}`;

// ---- The web image under test (built once by globalSetup) ----

export interface WebImageInfo {
	image?: string;
	dist?: string;
	artifact?: string;
	source?: string;
	error?: string;
}

export const webImageInfo = (): Required<Omit<WebImageInfo, 'error'>> => {
	const raw = process.env.NOTESTEAD_M1S4_WEB_IMAGE;
	if (!raw) throw new Error('the contract globalSetup did not run: use `corepack yarn jest -c jest.contract.config.js`');
	const info = JSON.parse(raw) as WebImageInfo;
	if (info.error) throw new Error(`the web image under test could not be built: ${info.error}`);
	if (!info.image || !info.dist || !info.artifact || !info.source) throw new Error(`incomplete web image info: ${raw}`);
	return { image: info.image, dist: info.dist, artifact: info.artifact, source: info.source };
};

// ---- Stacks ----

export interface Stack {
	suite: string;
	net: string;
	prefix: string;
	containers: string[];
	logsDir: string;
}

export const usedSubnets = (): Set<string> => {
	const names = podman(['network', 'ls', '--format', '{{.Name}}']).stdout.split('\n').filter(n => n !== '');
	const used = new Set<string>();
	if (names.length === 0) return used;
	const out = podman(['network', 'inspect', '--format', '{{range .Subnets}}{{.Subnet}} {{end}}', ...names]).stdout;
	for (const cidr of out.split(/\s+/).filter(c => c !== '')) used.add(cidr.split('/')[0].split('.').slice(0, 3).join('.'));
	return used;
};

// A free 10.89.200-254.0/24 prefix (`10.89.N`) that no existing podman network uses.
export const freeSubnetPrefix = (): string => {
	const used = usedSubnets();
	for (let third = 200; third < 255; third++) if (!used.has(`10.89.${third}`)) return `10.89.${third}`;
	throw new Error('no free 10.89.200-254.0/24 subnet for the test network');
};

// `story` names the results dir: test-results/contract/<story>/<suite>/.
export const createStack = (suite: string, story = 'm1-s4'): Stack => {
	const prefix = freeSubnetPrefix();
	const net = `nst-${suite}-${runId()}`;
	podman(['network', 'create', '--subnet', `${prefix}.0/24`, '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, net]);
	const logsDir = join(repoRoot, 'test-results', 'contract', story, suite);
	mkdirSync(logsDir, { recursive: true });
	return { suite, net, prefix, containers: [], logsDir };
};

export const ipOf = (stack: Stack, host: number): string => `${stack.prefix}.${host}`;

export interface ContainerSpec {
	role: string;
	image: string;
	host: number;
	env?: Record<string, string | undefined>;
	publish?: number[];
	args?: string[];
	volumes?: string[];
	command?: string[];
}

export const containerName = (stack: Stack, role: string): string => `nst-${stack.suite}-${role}-${runId()}`;

export const startContainer = (stack: Stack, spec: ContainerSpec): string => {
	const name = containerName(stack, spec.role);
	const args = ['run', '-d', '--name', name, '--network', stack.net, '--ip', ipOf(stack, spec.host),
		'--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`];
	for (const port of spec.publish ?? []) args.push('-p', `127.0.0.1::${port}`);
	for (const [key, value] of Object.entries(spec.env ?? {})) if (value !== undefined) args.push('-e', `${key}=${value}`);
	for (const volume of spec.volumes ?? []) args.push('-v', volume);
	args.push(...(spec.args ?? []), spec.image, ...(spec.command ?? []));
	stack.containers.push(name);
	podman(args);
	return name;
};

export const hostPort = (name: string, port: number): number => {
	const line = podman(['port', name, `${port}/tcp`]).stdout.trim().split('\n')[0] ?? '';
	const value = Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`no published host port for ${name}:${port} (podman port said ${JSON.stringify(line)})`);
	return value;
};

export interface ContainerState {
	status: string;
	exitCode: number;
	oomKilled: boolean;
}

export const containerState = (name: string): ContainerState => {
	const [status, exitCode, oom] = podman(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}', name]).stdout.trim().split(' ');
	return { status, exitCode: Number.parseInt(exitCode, 10), oomKilled: oom === 'true' };
};

export const containerLogs = (name: string): string => {
	const r = podman(['logs', name], { allowFail: true });
	return `${r.stdout}${r.stderr}`;
};

// Fails fast (with the container's log tail) when a container being waited on has exited.
export const exitedWith = (name: string): string | undefined => {
	const state = containerState(name);
	if (state.status === 'running') return undefined;
	return `${name} is ${state.status} (exit ${state.exitCode}); log tail:\n${redact(containerLogs(name)).slice(-3000)}`;
};

// Writes every container's log (redacted) under test-results/contract/m1-s4/<suite>/, then removes the containers and
// the network. Safe on a partially created stack.
export const teardownStack = (stack: Stack | undefined): void => {
	if (!stack) return;
	for (const name of stack.containers) {
		writeFileSync(join(stack.logsDir, `${name}.log`), redact(containerLogs(name)));
	}
	if (stack.containers.length > 0) podman(['rm', '-f', '-t', '0', ...stack.containers], { allowFail: true });
	podman(['network', 'rm', '-f', stack.net], { allowFail: true });
};

// Removes everything a test run labelled: containers, networks, volumes (`run` = one run id, or, when omitted, every
// resource carrying the test label with any value: `contract` stacks and the compose test stacks of M1-S6, `stack`).
export const removeLabelled = (run?: string): void => {
	const filter = run ? `label=${runLabel}=${run}` : `label=${testLabel}`;
	const containers = podman(['ps', '-a', '--filter', filter, '--format', '{{.Names}}'], { allowFail: true }).stdout.split('\n').filter(n => n !== '');
	if (containers.length > 0) podman(['rm', '-f', '-t', '0', ...containers], { allowFail: true });
	const networks = podman(['network', 'ls', '--filter', filter, '--format', '{{.Name}}'], { allowFail: true }).stdout.split('\n').filter(n => n !== '');
	if (networks.length > 0) podman(['network', 'rm', '-f', ...networks], { allowFail: true });
	const volumes = podman(['volume', 'ls', '--filter', filter, '--format', '{{.Name}}'], { allowFail: true }).stdout.split('\n').filter(n => n !== '');
	if (volumes.length > 0) podman(['volume', 'rm', '-f', ...volumes], { allowFail: true });
};

// ---- Fixture clients: short-lived Node containers at fixed addresses (the TCP peer the web container sees) ----

export interface ClientRequest {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface ClientResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

let clientCounter = 0;

export const runClient = (stack: Stack, host: number, requests: ClientRequest[]): ClientResponse[] => {
	const name = containerName(stack, `client${host}-${++clientCounter}`);
	const r = podman(['run', '--rm', '--name', name, '--network', stack.net, '--ip', ipOf(stack, host),
		'--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`,
		'-v', `${join(fixturesDir, 'http-client.mjs')}:/fixture/http-client.mjs:ro,Z`,
		nodeImage, 'node', '/fixture/http-client.mjs', JSON.stringify({ requests })], { allowFail: true });
	const line = r.stdout.trim().split('\n').pop() ?? '';
	if (r.code !== 0 || !line.startsWith('[')) throw new Error(`fixture client at ${ipOf(stack, host)} failed (exit ${r.code}): ${redact(`${r.stdout}\n${r.stderr}`).slice(-2000)}`);
	return JSON.parse(line) as ClientResponse[];
};
