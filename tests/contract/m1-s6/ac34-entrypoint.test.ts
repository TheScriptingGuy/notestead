// M1-AC34: the `web` entrypoint refuses unsafe configuration before Caddy starts (ADR-0002 §Configuration, ADR-0008;
// carried over from M1-S4). Each unsafe value exits 64, names the variable, and no Caddy process ever ran (the
// container exited; Caddy never logged). Positive control: the same image with valid values becomes healthy by the
// compose healthcheck and answers /joplin-server/api/ping from the server. docs/test-plans/M1-S6.md.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { request } from '../support/http.ts';
import {
	containerLogs, containerName, containerState, createStack, hostPort, podman, repoRoot, runId, runLabel, teardownStack, testLabel,
	waitFor, webImageInfo,
} from '../support/podman.ts';
import type { Stack } from '../support/podman.ts';
import { hardening, publicUrl, startJoplinServer } from '../support/services.ts';
import type { JoplinServer } from '../support/services.ts';

const minute = 60_000;

interface Case {
	id: string;
	variable: string;
	env: Record<string, string>;
}

const base = (serverUrl: string): Record<string, string> => ({ JOPLIN_SERVER_URL: serverUrl, JOPLIN_SERVER_PUBLIC_URL: publicUrl });

const unsafeHosts: [string, string][] = [
	['open-brace', 'joplin.example.test{'],
	['close-brace', '}joplin.example.test'],
	['space', 'joplin example.test'],
	['tab', 'joplin.example.test\t'],
	['double-quote', '"joplin.example.test"'],
	['single-quote', 'joplin.example.test\''],
	['backslash', 'joplin\\example.test'],
	['hash', 'joplin.example.test#x'],
	['newline', 'joplin.example.test\nimport evil'],
];

const cases = (serverUrl: string): Case[] => [
	...unsafeHosts.map(([id, value]) => ({ id: `host-${id}`, variable: 'JOPLIN_SERVER_HOST', env: { ...base(serverUrl), JOPLIN_SERVER_HOST: value } })),
	{ id: 'url-credentials', variable: 'JOPLIN_SERVER_URL', env: { ...base('http://user:secret@server.invalid:22300'), JOPLIN_SERVER_PUBLIC_URL: publicUrl } },
	{ id: 'url-path', variable: 'JOPLIN_SERVER_URL', env: base('http://server.invalid:22300/joplin') },
	{ id: 'url-query', variable: 'JOPLIN_SERVER_URL', env: base('http://server.invalid:22300?x=1') },
	{ id: 'coep-unsafe-none', variable: 'COEP', env: { ...base(serverUrl), COEP: 'unsafe-none' } },
	{ id: 'coep-case', variable: 'COEP', env: { ...base(serverUrl), COEP: 'Credentialless' } },
	{ id: 'coep-list', variable: 'COEP', env: { ...base(serverUrl), COEP: 'require-corp, credentialless' } },
	{ id: 'client-ip-header-alone', variable: 'CLIENT_IP_HEADER', env: { ...base(serverUrl), CLIENT_IP_HEADER: 'CF-Connecting-IP' } },
];

// The compose file's own web healthcheck (tests/stack/compose.yaml), so the positive control uses the same check.
const webHealthcheck = (): string => {
	const compose = parse(readFileSync(join(repoRoot, 'tests', 'stack', 'compose.yaml'), 'utf8')) as { services: { web: { healthcheck: { test: string } } } };
	return compose.services.web.healthcheck.test;
};

// A Caddy log line: JSON with a level (Caddy logs as soon as it starts, before it listens).
const caddyLines = (log: string): string[] => log.split('\n').filter(l => {
	try {
		const entry = JSON.parse(l) as { level?: string; logger?: string };
		return typeof entry.level === 'string';
	} catch {
		return false;
	}
});

describe('M1-AC34 web entrypoint refuses unsafe configuration', () => {
	let stack: Stack | undefined;
	let server: JoplinServer | undefined;
	let image = '';

	beforeAll(async () => {
		image = webImageInfo().image;
		stack = createStack('entry', 'm1-s6');
		server = await startJoplinServer(stack, { role: 'server', host: 30, testing: true });
	}, 10 * minute);

	afterAll(() => {
		teardownStack(stack);
	});

	const runWeb = (role: string, env: Record<string, string>, extra: string[] = []): string => {
		if (!stack) throw new Error('no stack');
		const name = containerName(stack, role);
		const args = ['run', '-d', '--name', name, '--network', stack.net, '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`,
			'-p', '127.0.0.1::8080', ...hardening, ...extra];
		for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
		stack.containers.push(name);
		podman([...args, image]);
		return name;
	};

	const refused = async (c: Case): Promise<void> => {
		const name = runWeb(`bad-${c.id}`, c.env);
		const state = await waitFor(`${name} to exit`, async () => {
			const s = containerState(name);
			return s.status === 'running' || s.status === 'created' || s.status === 'configured' ? undefined : s;
		}, { timeoutMs: 60_000, intervalMs: 200 });
		const log = containerLogs(name);
		expect({ case: c.id, status: state.status, exitCode: state.exitCode }).toEqual({ case: c.id, status: 'exited', exitCode: 64 });
		expect({ case: c.id, namesVariable: log.includes(c.variable) }).toEqual({ case: c.id, namesVariable: true });
		expect({ case: c.id, caddyLogged: caddyLines(log) }).toEqual({ case: c.id, caddyLogged: [] });
		expect({ case: c.id, started: log.includes('notestead-web: /joplin-server/api/* ->') }).toEqual({ case: c.id, started: false });
	};

	test('ac34 every unsafe value exits 64 naming its variable, before Caddy starts', async () => {
		expect(server).toBeDefined();
		const all = cases(server?.url ?? '');
		expect(all.length).toBe(16);
		for (const c of all) await refused(c);
	}, 15 * minute);

	test('ac34-trailing-slash a JOPLIN_SERVER_URL ending in / is refused with 64 or normalised, never left to Caddy (review M1-S4-r1 nit 6)', async () => {
		const name = runWeb('slash', base(`${server?.url ?? ''}/`), ['--health-cmd', webHealthcheck(), '--health-interval', '1s', '--health-retries', '3']);
		const outcome = await waitFor(`${name} to exit or become healthy`, async () => {
			const s = containerState(name);
			if (s.status !== 'running') return { exited: s.exitCode };
			const health = podman(['inspect', '--format', '{{.State.Health.Status}}', name]).stdout.trim();
			return health === 'healthy' ? { healthy: true } : undefined;
		}, { timeoutMs: 2 * minute, intervalMs: 250 });
		if ('exited' in outcome) {
			const log = containerLogs(name);
			expect({ exitCode: outcome.exited, namesVariable: log.includes('JOPLIN_SERVER_URL'), caddyLogged: caddyLines(log).length }).toEqual({ exitCode: 64, namesVariable: true, caddyLogged: 0 });
		} else {
			const res = await request({ port: hostPort(name, 8080), path: '/joplin-server/api/ping' });
			expect({ status: res.status, body: res.text }).toEqual({ status: 200, body: expect.stringContaining('"status":"ok"') });
		}
	}, 5 * minute);

	test('ac34-pos valid values: the same image becomes healthy and answers /joplin-server/api/ping', async () => {
		const name = runWeb('valid', { ...base(server?.url ?? ''), COEP: 'require-corp', TRUSTED_PROXIES: '10.89.0.2/32', CLIENT_IP_HEADER: 'CF-Connecting-IP', JOPLIN_SERVER_HOST: 'joplin.example.test' },
			['--health-cmd', webHealthcheck(), '--health-interval', '1s', '--health-retries', '3']);
		await waitFor(`${name} healthy`, async () => (podman(['inspect', '--format', '{{.State.Health.Status}}', name]).stdout.trim() === 'healthy' ? true : undefined), {
			timeoutMs: 2 * minute,
			failFast: () => (containerState(name).status === 'running' ? undefined : `${name} exited: ${containerLogs(name).slice(-1500)}`),
		});
		const res = await request({ port: hostPort(name, 8080), path: '/joplin-server/api/ping' });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toMatchObject({ status: 'ok' });
		expect(caddyLines(containerLogs(name)).length).toBeGreaterThan(0);
	}, 5 * minute);
});
