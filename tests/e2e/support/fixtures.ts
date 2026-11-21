// Playwright fixtures of the Notestead harness (ADR-0007 §Fixtures and isolation; docs/test-plans/M1-S6.md):
//   worker  stack         the compose test stack globalSetup started (or attached to), read from NOTESTEAD_E2E_STACK
//           joplinServer  that stack's throwaway Joplin Server: direct URL, the proxied URL through web, a request helper
//   test    e2eeAccount   a fresh server user whose E2EE "other device" turned E2EE on and seeded a folder and notes
//                         (option `e2eeSeed`: { notes, extras }, default one note; extras: a to-do with todo_due, a tag
//                         on note 1 and a text attachment on a note of its own, M2-S2 D7)
//           plainAccount  a fresh server user with no E2EE and no data (M2-S1)
//           headlessService  a fresh headless service (own compose project, own profile volume) for that account,
//                         healthy (ADR-0007's `headless`; Playwright reserves the name `headless` for its own option)
//           dataApi       GET, any method, fileDigest and createResource on that headless service's Data API, from inside its network
//                         namespace (never published; no token and no file body leaves the container)
//           webApp        a fresh BrowserContext (fresh OPFS and service worker) on the web container, 127.0.0.1 origin,
//                         en-GB, in the time zone of the option `webTimezone` (default Europe/Amsterdam)
//           webNetwork    a recorder of every request of the webApp context (tests/e2e/support/network.ts); on failure it
//                         attaches network.log (query strings removed). It only observes, it never routes. At teardown it
//                         checks the network policy over the whole test (M2-S1 r1 C2), minus the requests named with `allow`.
//           extraWebs     further `web` containers of the image under test, optionally serving another bundle, on a port of the test's
//                         choice (M2-S6 D3); removed at teardown, their logs attached on failure
//           appContexts   browser contexts on other origins (`http://localhost:<port>`), each fresh (own OPFS, service worker),
//                         with the console, the trace, a network recorder and the WEB-SQLITE-1 check of `webApp` (M2-S6 D4)
//   worker  unoverlaidDist the served bundle with every overlay change undone from upstream's public/ at the pin, two directories
//                         under test-results/e2e/m2-s6-dists/ removed at worker teardown (M2-S6 D2; never committed)
//           testFiles     files generated from a per-test seed in a temp dir outside test-results/, removed at teardown (M2-S3 D4)
//           stackLogs     (auto) on failure attaches the server, web and default supervisor logs of the test's time span
//   worker  redactStdio   (auto) the worker's stdout/stderr redacted at the source with every secret the worker knows
//                         (the `list` reporter prints those chunks live; M1-S6a C1)
// Every secret a fixture creates is registered (tests/support/secrets.ts) for the redacting reporter. Every attachment
// is redacted before it is written (tests/support/redact.ts); the redacting reporter then redacts the Playwright trace,
// every other attachment, errors, stdout/stderr and step titles once more (tests/e2e/support/redactingReporter.ts).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { checkServerUrl } from '../../stack/guard.ts';
import {
	containerLog, createAccount, downHeadless, enableE2ee, knownSecrets, projectContainers, registerToken, removeContainer, secretsFor, serverRequest,
	StackHealthError, upExtraWeb, upHeadless, upWebWithoutHostRewrite,
} from '../../stack/stack.ts';
import type { Account, ExtraWeb, HeadlessService, StackState } from '../../stack/stack.ts';
import type { HttpResponse } from '../../contract/support/http.ts';
import { redactText } from '../../support/redact.ts';
import type { KnownSecret } from '../../support/redact.ts';
import { installStdioRedaction, mergeSecrets, registeredSecrets, secretFeedEnabled } from '../../support/secrets.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { browserLocale } from './chromium.ts';
import { cleanupAll } from './cleanup.ts';
import { userTimeZone } from './dueDate.ts';
import { writeBinary, writePng } from './testFiles.ts';
import type { GeneratedFile } from './testFiles.ts';
import type { SqliteFailure } from './webSqlite.ts';
import { estimatePageChoice, occurrenceRecord, sqliteFailureLines, sqliteFailures } from './webSqlite.ts';
import { headlessUpTimeoutMs } from './timeouts.ts';
import { stackEnv } from './globalSetup.ts';
import { endOfTestViolations, recordNetwork } from './network.ts';
import type { NetworkRecorder } from './network.ts';
import { requireUpstreamBundle } from './bundle.ts';
import type { UnoverlaidDirs } from './unoverlaid.ts';

export interface JoplinServerHandle {
	// http://127.0.0.1:<published port>; needs the Host of APP_BASE_URL (use `request`)
	url: string;
	// the URL a client syncs with: http://127.0.0.1:<web port>/joplin-server
	proxiedUrl: string;
	publicUrl: string;
	request: (path: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<HttpResponse>;
}

export interface DataApiResult {
	status?: number;
	body?: unknown;
	error?: string;
}

export interface FileDigest { status?: number; sha256?: string; size?: number; contentType?: string; error?: string }

export interface DataApi {
	get: (path: string) => DataApiResult;
	// Any method, with a JSON body made by the test (M1-S7: POST /notes); tests/fixtures/m1-s7/in-container
	request: (method: string, path: string, body?: unknown) => DataApiResult;
	// GET /resources/:id/file streamed into a sha256 inside the container (M2-S3 D4); no file body leaves it
	fileDigest: (resourceId: string, opts?: { timeoutMs?: number }) => FileDigest;
	// POST /resources (multipart) of a small file (at most 64 KiB), from inside the container
	createResource: (file: { title: string; fileName: string; mime: string; bytes: Buffer }) => DataApiResult;
}

export interface TestFiles {
	dir: string;
	png: (name: string, opts: { width: number; height: number; totalBytes?: number }) => GeneratedFile;
	binary: (name: string, size: number) => GeneratedFile;
	made: () => GeneratedFile[];
}

export interface WebApp {
	context: BrowserContext;
	page: Page;
	baseURL: string;
	console: string[];
	// Opts this test out of the browser SQLite failure check (WEB-SQLITE-1), with the reason recorded as an annotation. No
	// spec uses it; it exists for a future story that injects faults on purpose.
	allowSqliteFailures: (reason: string) => void;
}

// A browser context of `appContexts`: a WebApp plus the network recorder of its context.
export interface AppContext extends WebApp {
	network: NetworkRecorder;
}

export interface ExtraWebStart {
	role: 'web-extra' | 'web-unoverlaid';
	// default: a free port
	port?: number;
	// a directory mounted read-only over /srv/www (the un-overlaid bundle, `unoverlaidDist.unoverlaid`)
	mountDist?: string;
}

export interface ExtraWebs {
	start: (opts: ExtraWebStart) => Promise<ExtraWeb>;
	// Removes the container (its log is kept for a failing test).
	stop: (web: ExtraWeb) => void;
}

export interface AppContexts {
	// A fresh context (and page) whose origin is `baseURL`, same locale and time zone as `webApp`. `label` names its attachments.
	open: (baseURL: string, label: string) => Promise<AppContext>;
	// Ends a context early (its OPFS worker stops, so another origin on the same port can start), keeping its evidence.
	close: (app: AppContext) => Promise<void>;
}

interface WorkerFixtures {
	stack: StackState;
	unoverlaidDist: UnoverlaidDirs;
	joplinServer: JoplinServerHandle;
	redactStdio: undefined;
}

interface TestFixtures {
	stackLogs: undefined;
	e2eeAccount: Account;
	e2eeSeed: { notes: number; extras?: boolean };
	plainAccount: Account;
	headlessService: HeadlessService;
	dataApi: DataApi;
	webApp: WebApp;
	testFiles: TestFiles;
	webTimezone: string;
	webNetwork: NetworkRecorder;
	webWithoutHostRewrite: ExtraWeb;
	extraWebs: ExtraWebs;
	appContexts: AppContexts;
}

const failed = (testInfo: TestInfo): boolean => testInfo.status !== testInfo.expectedStatus;

// Every secret this worker knows: the stack's accounts (the default one and every per-test one this worker created)
// and every registered secret (Data API tokens, secrets a test registered itself).
const workerSecrets = (stack: StackState): KnownSecret[] => mergeSecrets(secretsFor(stack), registeredSecrets());

// Writes `text` (already redacted) into the test's output dir and attaches it by path.
export const attachText = async (testInfo: TestInfo, name: string, text: string): Promise<void> => {
	const path = testInfo.outputPath(name);
	writeFileSync(path, text);
	await testInfo.attach(name, { path, contentType: 'text/plain' });
};

// A per-test headless service that did not start (CI-M2-S2 G): its supervisor log, `compose up`'s output and the last
// readiness observation (value-free) are attached to the test and written to the stack's logs dir, which the contract
// layer's artifact keeps even when the inner run's attachments are not kept. Nothing here throws: the original error stays.
const keepStartLogs = async (stack: StackState, project: string, error: unknown, testInfo: TestInfo): Promise<void> => {
	const secrets = workerSecrets(stack);
	const container = projectContainers(project).headless;
	const failure = error instanceof StackHealthError ? error : undefined;
	const files: Record<string, string> = {
		'supervisor.log': container ? containerLog(stack, container, undefined, secrets) : '(no headless container was created)\n',
		'compose-up.log': redactText(failure?.output ?? `(no compose output on the error)\n${(error as Error).message}`, secrets),
		'readiness.log': redactText(`${failure?.readiness ?? 'no readiness observation'}\n${(error as Error).message.split('\n')[0]}\n`, secrets),
	};
	mkdirSync(stack.logsDir, { recursive: true });
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(stack.logsDir, `${stack.project}-hl-${shortId(testInfo)}-${name}`), text);
		await attachText(testInfo, name, text);
	}
};

const maxSqliteArgs = 20;

// WEB-SQLITE-1 (WS-2): the evidence of a failing browser SQLite, written to web-sqlite.json (attached, and kept in the stack's
// logs dir): the value-free failures, the argument objects of the console messages, and the origin's storage estimate (is the
// quota or persistence the cause?). Nothing here throws: the failure itself is asserted by the caller.
const keepWebSqlite = async (stack: StackState, testInfo: TestInfo, app: { context: BrowserContext; page: Page; baseURL: string }, failures: SqliteFailure[], args: unknown[][], consoleLines: string[], label = ''): Promise<void> => {
	const readStorage = async (page: Page): Promise<{ estimate: unknown; persisted: boolean }> => {
		return await page.evaluate(async () => {
			const g = globalThis as unknown as { navigator: { storage: { estimate: () => Promise<unknown>; persisted: () => Promise<boolean> } } };
			return { estimate: await g.navigator.storage.estimate(), persisted: await g.navigator.storage.persisted() };
		});
	};
	let storage: unknown;
	try {
		if (!app.page.isClosed() && estimatePageChoice(app.page.url(), app.baseURL) === 'app') {
			storage = { from: 'app', ...await readStorage(app.page) };
		} else {
			const probe = await app.context.newPage();
			try {
				await probe.goto(new URL('/manifest.json', app.baseURL).href);
				storage = { from: 'probe', ...await readStorage(probe) };
			} finally {
				await probe.close();
			}
		}
	} catch (error) {
		storage = `(storage estimate failed: ${(error as Error).name})`;
	}
	const text = redactText(JSON.stringify({ failures, args, storage, records: occurrenceRecord(failures, consoleLines) }, null, 2), workerSecrets(stack));
	mkdirSync(stack.logsDir, { recursive: true });
	// A labelled session (appContexts) names its files after the label; scan-l20 finds both spellings.
	writeFileSync(join(stack.logsDir, `${stack.project}-${shortId(testInfo)}${label ? `-${label}` : ''}-web-sqlite.json`), text);
	const name = label ? `web-sqlite-${label}.json` : 'web-sqlite.json';
	const path = testInfo.outputPath(name);
	writeFileSync(path, text);
	await testInfo.attach(name, { path, contentType: 'application/json' });
};

const shortId = (testInfo: TestInfo): string => `${testInfo.testId.slice(0, 8)}${testInfo.retry ? `r${testInfo.retry}` : ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');

// The M1-S5 in-container Data API probe, piped to `node -` on stdin: no test files are mounted into the headless
// container, and the token never leaves it.
const dataApiProbe = (): string => readFileSync(join(findRepoRoot(), 'tests', 'fixtures', 'm1-s5', 'in-container', 'data-api.mjs'), 'utf8');
// The M1-S7 probe: any method, the JSON body base64-encoded in argv (a test-made note, never a secret).
// The M2-S3 probe: a resource's file digested inside the container, or a small resource created (docs/test-plans/M2-S3.md D4, D5).
const dataApiResourceProbe = (): string => readFileSync(join(findRepoRoot(), 'tests', 'fixtures', 'm2-s3', 'in-container', 'data-api-resource.mjs'), 'utf8');
const dataApiRequestProbe = (): string => readFileSync(join(findRepoRoot(), 'tests', 'fixtures', 'm1-s7', 'in-container', 'data-api-request.mjs'), 'utf8');

const runProbe = (container: string, probe: string, args: string[], timeoutMs = 120_000): DataApiResult => {
	const r = spawnSync('podman', ['exec', '-i', container, 'node', '-', ...args], { input: probe, encoding: 'utf8', timeout: timeoutMs });
	const line = (r.stdout ?? '').split('\n').filter(l => l.startsWith('RESULT ')).pop();
	if (!line) return { error: `data-api probe printed no result (exit ${r.status}): ${redactText(`${r.stdout}\n${r.stderr}`).slice(-1000)}` };
	return JSON.parse(line.slice('RESULT '.length)) as DataApiResult;
};

// One browser context of the app under test: the console and trace recording and the WEB-SQLITE-1 check that `webApp` always had,
// shared with `appContexts` (M2-S6 D4). `label` is '' for `webApp` (attachment names as before) or names a further context.
interface AppSession {
	app: AppContext;
	// Stops recording and closes the context before the end of the test; its evidence is kept for `finish`.
	closeEarly: () => Promise<void>;
	// The end of the test: evidence attached on failure, the context closed, the SQLite check asserted.
	finish: () => Promise<void>;
}

const startAppSession = async (browser: Browser, stack: StackState, testInfo: TestInfo, opts: { baseURL: string; timezone: string; label: string }): Promise<AppSession> => {
	// en-GB: the app picks its UI language from the browser's locale, and the page objects use upstream's en_GB
	// strings ("Synchronise"; en-US would give "Synchronize"). Playwright's own default is en-US.
	const context = await browser.newContext({ baseURL: opts.baseURL, locale: browserLocale, timezoneId: opts.timezone });
	const network = recordNetwork(context);
	const suffix = opts.label ? `-${opts.label}` : '';
	const lines: string[] = [];
	// WEB-SQLITE-1 evidence: the argument objects of the first 20 console messages that are a SQLite failure (they hold the
	// worker's error object: type, dbId, messageId, the result code). Each is read in a `try`: a page can be closing.
	const sqliteArgs: Promise<unknown[]>[] = [];
	const watch = (page: Page): void => {
		page.on('console', m => {
			const text = `${new Date().toISOString()} [${m.type()}] ${m.text()}`;
			lines.push(text);
			if (sqliteArgs.length < maxSqliteArgs && sqliteFailures([text]).length > 0) {
				sqliteArgs.push(Promise.all(m.args().map(async a => {
					try {
						return await a.jsonValue() as unknown;
					} catch {
						return '(unserialisable)';
					}
				})));
			}
		});
		page.on('pageerror', e => lines.push(`${new Date().toISOString()} [pageerror] ${e.message}`));
	};
	context.on('page', watch);
	// The trace of this context, kept on failure (docs/test-plans/M1-S7.md, Finding F2). The harness records it itself
	// instead of Playwright's `use.trace` (off in playwright.config.ts): the runner merges the test's traces with
	// yauzl, which never finishes on Node 24 once a trace entry is larger than 64 KiB (the real app's bundle, its DOM
	// snapshots), so a failing test hung until its timeout and lost its trace. tracing.stop({ path }) writes the zip
	// without reading one back. No screenshots: the screencast frames are pixels no redaction can reach (C1-R1); DOM
	// snapshots and network bodies are text, which the redacting reporter redacts.
	await context.tracing.start({ screenshots: false, snapshots: true, sources: true, title: `${testInfo.titlePath.join(' > ')}${suffix}` });
	const page = await context.newPage();
	let allowed: string | undefined;
	const allowSqliteFailures = (reason: string): void => {
		allowed = reason;
		testInfo.annotations.push({ type: 'allow-sqlite', description: reason });
	};
	const app: AppContext = { context, page, baseURL: opts.baseURL, console: lines, allowSqliteFailures, network };
	let early: { dir: string; trace: string } | undefined;

	const closeEarly = async (): Promise<void> => {
		if (early) return;
		const sqlite = sqliteFailures(lines);
		// The storage estimate and the failures' arguments are read while the context is still open.
		if (sqlite.length > 0 && allowed === undefined) await keepWebSqlite(stack, testInfo, app, sqlite, await Promise.all(sqliteArgs), lines, opts.label);
		const dir = mkdtempSync(join(tmpdir(), 'nst-trace-'));
		const trace = join(dir, 'trace.zip');
		early = { dir, trace };
		await context.tracing.stop({ path: trace });
		await context.close();
	};

	const finish = async (): Promise<void> => {
		// A real SQLite failure in the browser (a lost write, a failed start) fails the test here, at once, instead of
		// 60 s later as a data mismatch, or never (WEB-SQLITE-1). The evidence is kept as for any failure.
		const sqlite = sqliteFailures(lines);
		const sqliteFailing = sqlite.length > 0 && allowed === undefined;
		const keep = failed(testInfo) || sqliteFailing;
		try {
			if (early) {
				if (keep) {
					await attachText(testInfo, `browser-console${suffix}.log`, redactText(lines.join('\n'), workerSecrets(stack)));
					if (existsSync(early.trace)) await testInfo.attach(`trace${suffix}`, { path: early.trace, contentType: 'application/zip' });
				}
			} else {
				if (keep) {
					await attachText(testInfo, `browser-console${suffix}.log`, redactText(lines.join('\n'), workerSecrets(stack)));
					const path = testInfo.outputPath(`trace${suffix}.zip`);
					await context.tracing.stop({ path });
					await testInfo.attach(`trace${suffix}`, { path, contentType: 'application/zip' });
				} else {
					await context.tracing.stop();
				}
				if (sqliteFailing) await keepWebSqlite(stack, testInfo, app, sqlite, await Promise.all(sqliteArgs), lines, opts.label);
				await context.close();
			}
		} finally {
			if (early) rmSync(early.dir, { recursive: true, force: true });
		}
		if (allowed === undefined) expect(sqliteFailureLines(sqlite), `browser SQLite failures in this test${opts.label ? ` (${opts.label})` : ''} (WEB-SQLITE-1); the startup spellfix1 line is not one`).toEqual([]);
	};

	return { app, closeEarly, finish };
};

export const builtinFixtureMessage = (name: 'page' | 'context'): string => `the built-in \`${name}\` fixture is disabled in this harness: it records no trace and no browser console (use.trace is off). Use the \`webApp\` fixture (webApp.page, webApp.context) instead.`;

export const test = base.extend<TestFixtures, WorkerFixtures>({
	// Playwright's built-in page and context have no trace and no console log in this harness (use.trace is off; the
	// webApp fixture records both; review M1-S7-r1 C-N3, docs/testing/strategy.md §4).
	// eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a destructured object
	page: async ({}, _use) => {
		throw new Error(builtinFixtureMessage('page'));
	},
	// eslint-disable-next-line no-empty-pattern -- as above
	context: async ({}, _use) => {
		throw new Error(builtinFixtureMessage('context'));
	},

	// eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a destructured object
	stack: [async ({}, use) => {
		// The guard again, in the worker: a worker can be started with a different environment than globalSetup.
		checkServerUrl(process.env.JOPLIN_SERVER_URL);
		const raw = process.env[stackEnv];
		if (!raw) throw new Error(`${stackEnv} is not set: run Playwright with playwright.config.ts (its globalSetup starts the stack)`);
		// Workers never own the stack: globalSetup's teardown removes it, and only that process writes its descriptor.
		await use({ ...JSON.parse(raw) as StackState, owned: false });
	}, { scope: 'worker' }],

	redactStdio: [async ({ stack }, use) => {
		// The C1 negative control (self-test runs only) knows only the default account, as the harness did before C1.
		const defaults = knownSecrets(stack); // a snapshot: the accounts of NOTESTEAD_E2E_STACK
		const restore = installStdioRedaction(() => (secretFeedEnabled() ? mergeSecrets(knownSecrets(stack), registeredSecrets()) : defaults));
		try {
			await use(undefined);
		} finally {
			restore();
		}
	}, { scope: 'worker', auto: true }],

	joplinServer: [async ({ stack }, use) => {
		if (!stack.serverUrl || !stack.webUrl) throw new Error('the stack has no server or web URL');
		await use({
			url: stack.serverUrl,
			proxiedUrl: `${stack.webUrl}/joplin-server`,
			publicUrl: 'https://joplin.example.test',
			request: (path, opts) => serverRequest(stack, path, opts),
		});
	}, { scope: 'worker' }],

	stackLogs: [async ({ stack }, use, testInfo) => {
		const since = new Date(Date.now() - 1_000).toISOString();
		await use(undefined);
		if (!failed(testInfo)) return;
		const secrets = workerSecrets(stack);
		if (stack.containers.server) await attachText(testInfo, 'server.log', containerLog(stack, stack.containers.server, since, secrets));
		if (stack.containers.web) await attachText(testInfo, 'web.log', containerLog(stack, stack.containers.web, since, secrets));
		if (stack.defaultHeadless?.container) await attachText(testInfo, 'supervisor-default.log', containerLog(stack, stack.defaultHeadless.container, since, secrets));
	}, { auto: true }],

	e2eeSeed: [{ notes: 1 }, { option: true }],

	e2eeAccount: async ({ stack, e2eeSeed }, use, testInfo) => {
		const account = await enableE2ee(stack, await createAccount(stack), shortId(testInfo), e2eeSeed);
		await use(account);
	},

	plainAccount: async ({ stack }, use) => {
		await use(await createAccount(stack));
	},

	headlessService: async ({ stack, e2eeAccount }, use, testInfo) => {
		let service: HeadlessService | undefined;
		try {
			try {
				service = await upHeadless(stack, e2eeAccount, shortId(testInfo), headlessUpTimeoutMs);
			} catch (error) {
				const project = `${stack.project}-hl-${shortId(testInfo)}`;
				// The half-started container's Data API token is registered for redaction before its logs are read (CI-M2-S2 r3 C2),
				// then the cleanup steps all run and the original error is rethrown (C1).
				const container = projectContainers(project).headless;
				if (container) registerToken({ container, label: `${shortId(testInfo)}-start` } as HeadlessService);
				return await cleanupAll([
					() => keepStartLogs(stack, project, error, testInfo),
					async () => { downHeadless(stack, stack.headless.find(h => h.project === project)); },
				], error);
			}
			await use(service);
		} finally {
			// The token again: a restart of the CLI inside the service rotates it.
			if (service?.container) registerToken(service);
			if (service?.container && failed(testInfo)) await attachText(testInfo, 'supervisor.log', containerLog(stack, service.container, undefined, workerSecrets(stack)));
			downHeadless(stack, service);
		}
	},

	dataApi: async ({ headlessService }, use) => {
		const probe = dataApiProbe();
		const requestProbe = dataApiRequestProbe();
		const resourceProbe = dataApiResourceProbe();
		await use({
			get: (path: string): DataApiResult => runProbe(headlessService.container, probe, [path]),
			request: (method: string, path: string, body?: unknown): DataApiResult => runProbe(headlessService.container, requestProbe,
				[method, path, ...(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8').toString('base64')])]),
			fileDigest: (resourceId, opts = {}) => {
				if (!/^[0-9a-f]{32}$/.test(resourceId)) throw new Error('fileDigest: a resource id is 32 hex characters');
				const timeoutMs = opts.timeoutMs ?? 120_000;
				return runProbe(headlessService.container, resourceProbe, ['digest', resourceId, String(timeoutMs)], timeoutMs + 30_000) as FileDigest;
			},
			createResource: file => {
				// The bytes travel base64 in argv (the probe itself comes on stdin): 64 KiB keeps them under Linux's 128 KiB argument limit.
				if (file.bytes.length > 64 * 1024) throw new Error(`createResource: ${file.bytes.length} bytes is over the probe's 64 KiB limit`);
				if (!/^[a-z0-9][a-z0-9.-]*$/.test(file.fileName)) throw new Error('createResource: unsafe file name');
				const meta = Buffer.from(JSON.stringify({ title: file.title, fileName: file.fileName, mime: file.mime }), 'utf8').toString('base64');
				return runProbe(headlessService.container, resourceProbe, ['create', '60000', meta, file.bytes.toString('base64')]);
			},
		});
	},

	// Files generated at test time from a per-test seed, outside test-results/ (never uploaded), removed at teardown; on failure
	// only their names, seeds, sizes and hashes are attached (docs/test-plans/M2-S3.md D4).
	// eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a destructured object
	testFiles: async ({}, use, testInfo) => {
		const dir = mkdtempSync(join(tmpdir(), 'nst-files-'));
		const run = randomBytes(4).toString('hex');
		const made: GeneratedFile[] = [];
		try {
			await use({
				dir,
				png: (name, opts) => { const f = writePng(dir, name, `${run}/${name}`, opts); made.push(f); return f; },
				binary: (name, size) => { const f = writeBinary(dir, name, `${run}/${name}`, size); made.push(f); return f; },
				made: () => made.map(f => ({ ...f })),
			});
		} finally {
			if (failed(testInfo)) await attachText(testInfo, 'test-files.json', `${JSON.stringify(made.map(({ name, seed, size, sha256, width, height }) => ({ name, seed, size, sha256, width, height })), null, 2)}\n`);
			rmSync(dir, { recursive: true, force: true });
		}
	},

	// A second web container whose proxy does not rewrite Host (M1-AC21 NEG; tests/stack/stack.ts upWebWithoutHostRewrite).
	webWithoutHostRewrite: async ({ stack }, use, testInfo) => {
		let web: ExtraWeb | undefined;
		try {
			web = await upWebWithoutHostRewrite(stack, shortId(testInfo));
			await use(web);
		} finally {
			if (web && failed(testInfo)) await attachText(testInfo, 'web-without-host-rewrite.log', containerLog(stack, web.container, undefined, workerSecrets(stack)));
			if (web) removeContainer(stack, web.container);
		}
	},

	// The network log of the webApp context, for the policy checks and as an attachment on failure (M2-S1).
	webNetwork: async ({ webApp, stack }, use, testInfo) => {
		const recorder = recordNetwork(webApp.context);
		await use(recorder);
		// The whole test's traffic, checked as the context is about to close (review M2-S1-r1 C2): a request the app makes
		// late, such as a periodic re-sync, is seen too.
		const late = endOfTestViolations(recorder.entries(), new URL(webApp.baseURL).origin, recorder.allowed());
		if (failed(testInfo) || late.length > 0) await attachText(testInfo, 'network.log', redactText(recorder.text(), workerSecrets(stack)));
		expect(late, 'network policy over the whole test, checked at its end (M2-S1 r1 C2)').toEqual([]);
	},

	// Europe/Amsterdam: the user's zone (gate 1, Q9); M2-AC5 asserts due dates as epochs in it (docs/test-plans/M2-S2.md D5).
	webTimezone: [userTimeZone, { option: true }],

	webApp: async ({ browser, stack, webTimezone }, use, testInfo) => {
		if (!stack.webUrl) throw new Error('the stack has no web URL');
		// 127.0.0.1, never localhost: upstream's environment.js turns on dev mode for any origin containing "localhost".
		const session = await startAppSession(browser, stack, testInfo, { baseURL: stack.webUrl, timezone: webTimezone, label: '' });
		try {
			await use(session.app);
		} finally {
			await session.finish();
		}
	},

	// The served bundle with every overlay change undone from upstream's public/ at the pin (docs/test-plans/M2-S6.md D2).
	// Built once per worker from the stack's own web container; the directories hold upstream's files and are removed at
	// worker teardown. Never committed (they live under test-results/, which is ignored).
	unoverlaidDist: [async ({ stack }, use, workerInfo) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		const dir = join(findRepoRoot(), 'test-results', 'e2e', 'm2-s6-dists', `w${workerInfo.workerIndex}-${process.pid}`);
		try {
			// Loaded here, not at the top: unoverlaid.ts reads upstream's tree through tests/acceptance/support/upstream.mts (ESM with
			// import.meta, which Jest's CommonJS transform cannot parse), and the Jest unit tests import this module's types.
			const { reconstructUnoverlaid } = await import('./unoverlaid.ts');
			await use(reconstructUnoverlaid(stack, dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, { scope: 'worker' }],

	// Further web containers of the image under test (docs/test-plans/M2-S6.md D3).
	extraWebs: async ({ stack }, use, testInfo) => {
		const running = new Map<string, ExtraWeb>();
		const logs = new Map<string, string>();
		let n = 0;
		const stop = (web: ExtraWeb): void => {
			if (!running.delete(web.container)) return;
			logs.set(web.container, containerLog(stack, web.container, undefined, workerSecrets(stack)));
			removeContainer(stack, web.container);
		};
		try {
			await use({
				start: async opts => {
					n++;
					const web = await upExtraWeb(stack, { label: `${shortId(testInfo)}-${n}`, role: opts.role, port: opts.port, mountDist: opts.mountDist });
					running.set(web.container, web);
					return web;
				},
				stop,
			});
		} finally {
			for (const web of [...running.values()]) stop(web);
			if (failed(testInfo)) for (const [container, text] of logs) await attachText(testInfo, `${container.slice(stack.project.length + 1)}.log`, text);
		}
	},

	// Contexts on other origins (docs/test-plans/M2-S6.md D4), for example `http://localhost:<port>` of an extra web container.
	appContexts: async ({ browser, stack, webTimezone }, use, testInfo) => {
		const sessions = new Map<AppContext, AppSession>();
		// Every session is finished even when an earlier one throws (its SQLite check); the first error is rethrown.
		let first: unknown;
		try {
			await use({
				open: async (baseURL, label) => {
					if (!/^[a-z0-9-]+$/.test(label)) throw new Error(`appContexts.open: the label ${JSON.stringify(label)} must be lowercase letters, digits and dashes`);
					const session = await startAppSession(browser, stack, testInfo, { baseURL, timezone: webTimezone, label });
					sessions.set(session.app, session);
					return session.app;
				},
				close: async app => {
					const session = sessions.get(app);
					if (!session) throw new Error('appContexts.close: not a context of this test');
					await session.closeEarly();
				},
			});
		} finally {
			for (const session of sessions.values()) {
				try {
					await session.finish();
				} catch (error) {
					first ??= error;
				}
			}
		}
		if (first) throw first;
	},
});

export { expect };
