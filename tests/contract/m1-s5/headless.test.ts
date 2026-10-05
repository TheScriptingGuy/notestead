// M1-S5 contract suite: the `headless` container (minimal supervisor). docs/test-plans/M1-S5.md; ADRs 0003, 0006,
// 0008. Real containers only: a throwaway joplin/server at the pin, the `web` image of M1-S4, the CLI "other device"
// fixture (E2EE on) and the headless image under test, in the ADR-0006 topology (headless on an --internal network
// whose only other member is web's internal listener). Every test has its own user, other device, secrets, headless
// container and profile volume.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	backClient, cliCommand, createBack, createUser, dataApi, deviceImage, execIn, hasTokens, headlessImage, healthLines,
	healthPort, isCli, makeSecret, parseBody, removeBack, scrub, seedDevice, serverItem, startHeadless, startObserver, startStack,
	startWatcher, stopContainer, stopHeadless, waitForReady,
} from '../support/headless.ts';
import type { Back, Headless, HeadlessStack, HealthLine, Secret, User, WatchedProcess, Watcher } from '../support/headless.ts';
import { containerLogs, createStack, exitedWith, podman, teardownStack, waitFor } from '../support/podman.ts';
import type { Stack } from '../support/podman.ts';

const envFor = (user: User, serverUrl = 'http://web:8089/joplin-server'): Record<string, string> => ({
	JOPLIN_SERVER_URL: serverUrl,
	JOPLIN_USERNAME: user.email,
});

const needlesOf = (...secrets: Secret[]): { label: string; value: string }[] =>
	secrets.flatMap(s => [{ label: s.label, value: s.value }, { label: `${s.label}(core)`, value: s.core }]);

const responses = (lines: HealthLine[]): HealthLine[] => lines.filter(l => l.status !== undefined);

const named = (processes: WatchedProcess[], command: string): WatchedProcess[] =>
	processes.filter(p => isCli(p) && cliCommand(p).filter(a => !a.startsWith('-')).join(' ') === command);

// ADR-0003 Decision 1: the CLI runs only through these public commands, on the /data/profile profile.
const allowedCommands: Record<string, string[]> = {
	'config --import': ['config', '--import'],
	sync: ['sync'],
	'e2ee decrypt --force': ['e2ee', 'decrypt', '--force'],
	'server start --quiet': ['server', 'start', '--quiet'],
	version: ['version'],
};
const classify = (p: WatchedProcess): string | null => {
	const got = [...cliCommand(p)].sort().join(' ');
	return Object.entries(allowedCommands).find(([, tokens]) => [...tokens].sort().join(' ') === got)?.[0] ?? null;
};

const writeReport = (hs: HeadlessStack, label: string, value: unknown, secrets: Secret[]): void => {
	writeFileSync(join(hs.stack.logsDir, `${label}.json`), scrub(JSON.stringify(value, null, 1), secrets));
};

describe('M1-S5 headless container', () => {
	let stack: Stack | undefined;
	let back: Back | undefined;
	let hs: HeadlessStack;

	beforeAll(async () => {
		stack = createStack('hl', 'm1-s5');
		back = createBack(stack);
		hs = await startStack(stack, back);
		// Harness control: the internal sync path (back network → web :8089 → server) works before any headless runs.
		const [ping] = backClient(hs, [{ url: `http://${hs.webBackIp}:8089/joplin-server/api/ping` }]);
		if (ping.status !== 200 || !ping.body.includes('"status":"ok"')) throw new Error(`web :8089 on the back network answered ${ping.status}: ${ping.body.slice(0, 200)}`);
		deviceImage();
		try {
			headlessImage(); // built once here; a failure is recorded and re-thrown by each test where the image is needed
		} catch {
			// reported by startHeadless
		}
	}, 60 * 60_000);

	afterAll(() => {
		teardownStack(stack);
		removeBack(back);
	}, 5 * 60_000);

	test('ac14: secrets reach the CLI through `config --import` on stdin; no /proc/*/cmdline or environ holds a secret during startup (NEG: planted markers are found)', async () => {
		const user = await createUser(hs.server);
		const master = makeSecret('e2ee_master_password');
		seedDevice(hs, user, master, 'ac14');
		let observer: string | undefined;
		let h: Headless | undefined;
		let watcher: Watcher | undefined;
		try {
			observer = startObserver(hs, 'ac14');
			h = startHeadless(hs, { label: 'ac14', env: envFor(user), password: user.password, master, gate: true });
			const argvMarker = `nstargvmarker${randomBytes(8).toString('hex')}`;
			const envMarker = `nstenvmarker${randomBytes(8).toString('hex')}`;
			watcher = await startWatcher(h, [...needlesOf(user.password, master), { label: 'argv-marker', value: argvMarker }, { label: 'env-marker', value: envMarker }]);
			// NEG (probe control): values the probe must find, planted the way a leak would look.
			podman(['exec', '-d', h.name, 'node', '-e', 'setInterval(() => {}, 1000)', argvMarker]);
			podman(['exec', '-d', '-e', `NST_PLANTED=${envMarker}`, h.name, 'node', '-e', 'setInterval(() => {}, 1000)']);
			await waitForReady(observer, h);
			const report = await watcher.stop();
			watcher = undefined;
			writeReport(hs, 'ac14-watch-report', report, [user.password, master]);

			expect(report.hits.filter(hit => hit.label === 'argv-marker').map(hit => hit.where)).toContain('cmdline');
			expect(report.hits.filter(hit => hit.label === 'env-marker').map(hit => hit.where)).toContain('environ');
			expect(report.unreadable).toEqual([]);

			const imports = report.processes.filter(p => isCli(p) && hasTokens(p, 'config', '--import'));
			expect(imports.length).toBeGreaterThan(0);
			for (const p of imports) expect(p.fd0).toMatch(/^(pipe|socket):\[\d+\]$/);

			expect(report.hits.filter(hit => !hit.label.endsWith('-marker'))).toEqual([]);

			// ADR-0008: secrets are never logged (the supervisor's stdout/stderr and everything it relays).
			const logs = containerLogs(h.name);
			for (const s of [user.password, master]) {
				expect({ secret: s.label, inLogs: logs.includes(s.value) || logs.includes(s.core) }).toEqual({ secret: s.label, inLogs: false });
			}
		} finally {
			if (watcher) await watcher.stop().catch(() => undefined);
			stopContainer(hs, observer);
			stopHeadless(hs, h);
		}
	}, 30 * 60_000);

	test('ac15: GET /healthz is 503 {"state":"starting"} until the initial sync and e2ee decrypt finish, then 200 {"state":"ready","lastSync"}', async () => {
		const user = await createUser(hs.server);
		const master = makeSecret('e2ee_master_password');
		seedDevice(hs, user, master, 'ac15');
		let observer: string | undefined;
		let h: Headless | undefined;
		let watcher: Watcher | undefined;
		try {
			observer = startObserver(hs, 'ac15');
			h = startHeadless(hs, { label: 'ac15', env: envFor(user), password: user.password, master, gate: true });
			watcher = await startWatcher(h, []);
			const lines = await waitForReady(observer, h);
			const firstReady = lines.find(l => l.status === 200) as HealthLine;
			const settled = await waitFor('20 /healthz responses after ready', async () => {
				const later = responses(healthLines(observer as string)).filter(l => l.n > firstReady.n);
				return later.length >= 20 ? later : undefined;
			}, { timeoutMs: 60_000 });
			const report = await watcher.stop();
			watcher = undefined;
			writeReport(hs, 'ac15-watch-report', report, [user.password, master]);
			writeReport(hs, 'ac15-health', healthLines(observer), [user.password, master]);

			// Before ready: the endpoint answers, always 503 JSON {"state":"starting"}; once it answers, it stays up.
			const before = lines.filter(l => l.n < firstReady.n);
			const firstAnswer = before.find(l => l.status !== undefined);
			expect(firstAnswer).toBeDefined();
			expect(before.filter(l => l.n > (firstAnswer as HealthLine).n && l.error !== undefined)).toEqual([]);
			for (const l of responses(before)) {
				expect({ status: l.status, json: (l.type ?? '').startsWith('application/json'), state: parseBody(l)?.state }).toEqual({ status: 503, json: true, state: 'starting' });
			}

			// Ready: 200 JSON {"state":"ready","lastSync":<ISO-8601 UTC>}, and it stays ready.
			const ready = parseBody(firstReady);
			expect((firstReady.type ?? '').startsWith('application/json')).toBe(true);
			expect(ready?.state).toBe('ready');
			expect(String(ready?.lastSync)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
			for (const l of settled) expect({ status: l.status, state: parseBody(l)?.state }).toEqual({ status: 200, state: 'ready' });

			// Order, from the process watcher: sync and decrypt ran and ended before the first ready; healthz said 503
			// while the sync ran; the CLI server was up at ready; lastSync falls in that window.
			const syncs = named(report.processes, 'sync');
			const decrypts = named(report.processes, 'e2ee decrypt');
			const servers = named(report.processes, 'server start');
			expect(syncs.length).toBeGreaterThan(0);
			expect(decrypts.length).toBeGreaterThan(0);
			expect(servers.length).toBeGreaterThan(0);
			const syncEnd = Math.max(...syncs.map(p => p.lastSeen));
			const decryptEnd = Math.max(...decrypts.map(p => p.lastSeen));
			expect(firstReady.t).toBeGreaterThanOrEqual(syncEnd);
			expect(firstReady.t).toBeGreaterThanOrEqual(decryptEnd);
			expect(responses(before).some(l => l.status === 503 && l.t >= syncs[0].firstSeen && l.t <= syncs[0].lastSeen)).toBe(true);
			expect(servers.some(p => p.firstSeen <= firstReady.t && p.lastSeen >= firstReady.t)).toBe(true);
			const lastSync = Date.parse(String(ready?.lastSync));
			expect(lastSync).toBeGreaterThanOrEqual(syncs[0].firstSeen - 1_000);
			expect(lastSync).toBeLessThanOrEqual(firstReady.t + 1_000);

			// ADR-0003: only public CLI commands, all on /data/profile.
			const cli = report.processes.filter(isCli);
			for (const p of cli) {
				expect({ argv: p.argv.join(' '), command: classify(p), profile: p.argv[p.argv.indexOf('--profile') + 1] })
					.toEqual({ argv: p.argv.join(' '), command: expect.any(String), profile: '/data/profile' });
			}
		} finally {
			if (watcher) await watcher.stop().catch(() => undefined);
			stopContainer(hs, observer);
			stopHeadless(hs, h);
		}
	}, 30 * 60_000);

	test('ac15-neg: with the sync target refusing connections, /healthz keeps answering 503 and never reports ready', async () => {
		const user = await createUser(hs.server);
		const master = makeSecret('e2ee_master_password');
		let observer: string | undefined;
		let h: Headless | undefined;
		let watcher: Watcher | undefined;
		try {
			observer = startObserver(hs, 'ac15neg');
			// web's back address, on a port nothing listens on: every connection is refused.
			h = startHeadless(hs, { label: 'ac15neg', env: envFor(user, `http://${hs.webBackIp}:8099/joplin-server`), password: user.password, master, gate: true });
			watcher = await startWatcher(h, []);
			const name = h.name;
			const firstAnswer = await waitFor(`${name} first /healthz answer`, async () => responses(healthLines(observer as string))[0],
				{ timeoutMs: 5 * 60_000, intervalMs: 1_000, failFast: () => exitedWith(name) });
			// Observation window (an absence can only be shown over a bounded time): until the first CLI `sync` attempt has
			// ended plus 60 s (decrypt + server start + /ping take ~15 s on the Pi), and at least 120 s from the first answer.
			// With a refused target the CLI retries for ~2 min before `sync` exits 0 (QA probe), so a supervisor that trusts
			// the exit code would report ready inside this window. If no sync attempt ends, observe for 300 s. The container
			// may exit during the window (M1 doesn't require retrying); it must never report ready.
			const live = watcher;
			const windowEnd = (): number => {
				const syncEnded = live.gone().find(p => isCli(p) && cliCommand(p)[0] === 'sync');
				return syncEnded ? Math.max(syncEnded.lastSeen + 60_000, firstAnswer.t + 120_000) : firstAnswer.t + 300_000;
			};
			const premature = (): string | undefined => {
				const line = responses(healthLines(observer as string)).find(l => l.status === 200 || parseBody(l)?.state === 'ready');
				return line ? `reported ready while the sync target refused every connection: ${JSON.stringify(line)}` : undefined;
			};
			await waitFor('the end of the observation window', async () => (Date.now() >= windowEnd() ? true : undefined),
				{ timeoutMs: firstAnswer.t + 330_000 - Date.now(), intervalMs: 1_000, failFast: premature });
			const report = await watcher.stop();
			watcher = undefined;
			writeReport(hs, 'ac15neg-watch-report', report, [user.password, master]);
			const all = responses(healthLines(observer));
			writeReport(hs, 'ac15neg-health', all, [user.password, master]);
			expect(premature()).toBeUndefined();
			expect(firstAnswer.status).toBe(503);
			expect(all.filter(l => l.status === 200 || parseBody(l)?.state === 'ready')).toEqual([]);
			expect(all.filter(l => l.status !== 503)).toEqual([]);
		} finally {
			if (watcher) await watcher.stop().catch(() => undefined);
			stopContainer(hs, observer);
			stopHeadless(hs, h);
		}
	}, 30 * 60_000);

	test('ac16: a note created by the E2EE other device is returned decrypted by the internal GET /notes/:id after the initial sync', async () => {
		const user = await createUser(hs.server);
		const master = makeSecret('e2ee_master_password');
		const seeded = seedDevice(hs, user, master, 'ac16');
		const note = seeded.notes[0];
		// Fixture control: E2EE is on and the server holds only ciphertext for the note.
		expect(seeded.e2ee).toBe('Enabled');
		const item = await serverItem(hs.server, user, note.id);
		expect(item.status).toBe(200);
		expect(item.text).toMatch(/^encryption_applied: 1$/m);
		expect(item.text.includes(note.title) || item.text.includes(note.body)).toBe(false);

		let observer: string | undefined;
		let h: Headless | undefined;
		try {
			observer = startObserver(hs, 'ac16');
			h = startHeadless(hs, { label: 'ac16', env: envFor(user), password: user.password, master });
			await waitForReady(observer, h);
			// No polling after ready: ready means synced and decrypted.
			const got = dataApi(h, `/notes/${note.id}?fields=id,parent_id,title,body,encryption_applied`);
			expect(got).toMatchObject({ status: 200, body: { id: note.id, title: note.title, body: note.body, encryption_applied: 0 } });
			const parentId = (got.body as { parent_id: string }).parent_id;
			const folder = dataApi(h, `/folders/${parentId}?fields=id,title,encryption_applied`);
			expect(folder).toMatchObject({ status: 200, body: { id: parentId, title: seeded.folder, encryption_applied: 0 } });
		} finally {
			stopContainer(hs, observer);
			stopHeadless(hs, h);
		}
	}, 30 * 60_000);

	test('ac17: the CLI Data API (127.0.0.1:41184) is not reachable from outside the headless network namespace (NEG: from web; controls: inside, and web → :8090)', async () => {
		const user = await createUser(hs.server);
		const master = makeSecret('e2ee_master_password');
		const seeded = seedDevice(hs, user, master, 'ac17');
		const note = seeded.notes[0];
		let observer: string | undefined;
		let h: Headless | undefined;
		try {
			observer = startObserver(hs, 'ac17');
			h = startHeadless(hs, { label: 'ac17', env: envFor(user), password: user.password, master });
			await waitForReady(observer, h);
			const wget = (url: string): { code: number | null; out: string; stderr: string } => {
				const r = execIn(hs.web.name, ['wget', '-q', '-O', '-', '-T', '5', url], { timeoutMs: 60_000 });
				return { code: r.code, out: r.stdout, stderr: r.stderr };
			};

			// Positive control 1: inside the headless container the Data API answers.
			expect(dataApi(h, '/ping', { token: false })).toEqual({ status: 200, body: 'JoplinClipperServer' });

			for (const host of ['headless', h.ip]) {
				// Positive control 2: web reaches the headless container, by name and address, on the supervisor port.
				const health = wget(`http://${host}:${healthPort}/healthz`);
				expect({ host, code: health.code, ready: health.out.includes('"ready"') }).toEqual({ host, code: 0, ready: true });
				// NEG: the Data API port is closed to web.
				const api = wget(`http://${host}:41184/ping`);
				expect({ host, code: api.code === 0 ? 0 : 'failed', body: api.out }).toEqual({ host, code: 'failed', body: '' });
				expect(api.stderr).toMatch(/refused|timed out|unreachable|no route/i);
			}

			// The supervisor port does not relay the Data API (the gateway is opt-in, M3).
			for (const path of ['/ping', '/notes', `/notes/${note.id}`, '/api/ping', '/api/notes', `/api/notes/${note.id}`]) {
				const r = wget(`http://headless:${healthPort}${path}`);
				expect({ path, clipper: r.out.includes('JoplinClipperServer'), note: r.out.includes(note.title) }).toEqual({ path, clipper: false, note: false });
			}

			// Nothing is published on the host.
			const ports = JSON.parse(podman(['inspect', '--format', '{{json .NetworkSettings.Ports}}', h.name]).stdout || 'null') as Record<string, unknown[] | null> | null;
			expect(Object.values(ports ?? {}).filter(bindings => Array.isArray(bindings) && bindings.length > 0)).toEqual([]);
		} finally {
			stopContainer(hs, observer);
			stopHeadless(hs, h);
		}
	}, 30 * 60_000);
});
