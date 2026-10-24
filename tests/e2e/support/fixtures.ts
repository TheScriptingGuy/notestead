// Playwright fixtures of the Notestead harness (ADR-0007 §Fixtures and isolation; docs/test-plans/M1-S6.md):
//   worker  stack         the compose test stack globalSetup started (or attached to), read from NOTESTEAD_E2E_STACK
//           joplinServer  that stack's throwaway Joplin Server: direct URL, the proxied URL through web, a request helper
//   test    e2eeAccount   a fresh server user whose E2EE "other device" turned E2EE on and seeded a folder and notes
//                         (option `e2eeSeed`: { notes, extras }, default one note; extras: a to-do with todo_due, a tag
//                         on note 1 and a text attachment on a note of its own, M2-S2 D7)
//           plainAccount  a fresh server user with no E2EE and no data (M2-S1)
//           headlessService  a fresh headless service (own compose project, own profile volume) for that account,
//                         healthy (ADR-0007's `headless`; Playwright reserves the name `headless` for its own option)
//           dataApi       GET on that headless service's Data API, from inside its network namespace (never published)
//           webApp        a fresh BrowserContext (fresh OPFS and service worker) on the web container, 127.0.0.1 origin,
//                         en-GB, in the time zone of the option `webTimezone` (default Europe/Amsterdam)
//           webNetwork    a recorder of every request of the webApp context (tests/e2e/support/network.ts); on failure it
//                         attaches network.log (query strings removed). It only observes, it never routes. At teardown it
//                         checks the network policy over the whole test (M2-S1 r1 C2), minus the requests named with `allow`.
//           stackLogs     (auto) on failure attaches the server, web and default supervisor logs of the test's time span
//   worker  redactStdio   (auto) the worker's stdout/stderr redacted at the source with every secret the worker knows
//                         (the `list` reporter prints those chunks live; M1-S6a C1)
// Every secret a fixture creates is registered (tests/support/secrets.ts) for the redacting reporter. Every attachment
// is redacted before it is written (tests/support/redact.ts); the redacting reporter then redacts the Playwright trace,
// every other attachment, errors, stdout/stderr and step titles once more (tests/e2e/support/redactingReporter.ts).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { checkServerUrl } from '../../stack/guard.ts';
import {
	containerLog, createAccount, downHeadless, enableE2ee, knownSecrets, projectContainers, registerToken, removeContainer, secretsFor, serverRequest,
	StackHealthError, upHeadless, upWebWithoutHostRewrite,
} from '../../stack/stack.ts';
import type { Account, ExtraWeb, HeadlessService, StackState } from '../../stack/stack.ts';
import type { HttpResponse } from '../../contract/support/http.ts';
import { redactText } from '../../support/redact.ts';
import type { KnownSecret } from '../../support/redact.ts';
import { installStdioRedaction, mergeSecrets, registeredSecrets, secretFeedEnabled } from '../../support/secrets.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { browserLocale } from './chromium.ts';
import { userTimeZone } from './dueDate.ts';
import { headlessUpTimeoutMs } from './timeouts.ts';
import { stackEnv } from './globalSetup.ts';
import { endOfTestViolations, recordNetwork } from './network.ts';
import type { NetworkRecorder } from './network.ts';

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

export interface DataApi {
	get: (path: string) => DataApiResult;
	// Any method, with a JSON body made by the test (M1-S7: POST /notes); tests/fixtures/m1-s7/in-container
	request: (method: string, path: string, body?: unknown) => DataApiResult;
}

export interface WebApp {
	context: BrowserContext;
	page: Page;
	baseURL: string;
	console: string[];
}

interface WorkerFixtures {
	stack: StackState;
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
	webTimezone: string;
	webNetwork: NetworkRecorder;
	webWithoutHostRewrite: ExtraWeb;
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

const shortId = (testInfo: TestInfo): string => `${testInfo.testId.slice(0, 8)}${testInfo.retry ? `r${testInfo.retry}` : ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');

// The M1-S5 in-container Data API probe, piped to `node -` on stdin: no test files are mounted into the headless
// container, and the token never leaves it.
const dataApiProbe = (): string => readFileSync(join(findRepoRoot(), 'tests', 'fixtures', 'm1-s5', 'in-container', 'data-api.mjs'), 'utf8');
// The M1-S7 probe: any method, the JSON body base64-encoded in argv (a test-made note, never a secret).
const dataApiRequestProbe = (): string => readFileSync(join(findRepoRoot(), 'tests', 'fixtures', 'm1-s7', 'in-container', 'data-api-request.mjs'), 'utf8');

const runProbe = (container: string, probe: string, args: string[]): DataApiResult => {
	const r = spawnSync('podman', ['exec', '-i', container, 'node', '-', ...args], { input: probe, encoding: 'utf8', timeout: 120_000 });
	const line = (r.stdout ?? '').split('\n').filter(l => l.startsWith('RESULT ')).pop();
	if (!line) return { error: `data-api probe printed no result (exit ${r.status}): ${redactText(`${r.stdout}\n${r.stderr}`).slice(-1000)}` };
	return JSON.parse(line.slice('RESULT '.length)) as DataApiResult;
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
				await keepStartLogs(stack, project, error, testInfo);
				downHeadless(stack, stack.headless.find(h => h.project === project));
				throw error;
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
		await use({
			get: (path: string): DataApiResult => runProbe(headlessService.container, probe, [path]),
			request: (method: string, path: string, body?: unknown): DataApiResult => runProbe(headlessService.container, requestProbe,
				[method, path, ...(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8').toString('base64')])]),
		});
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
		// en-GB: the app picks its UI language from the browser's locale, and the page objects use upstream's en_GB
		// strings ("Synchronise"; en-US would give "Synchronize"). Playwright's own default is en-US.
		const context = await browser.newContext({ baseURL: stack.webUrl, locale: browserLocale, timezoneId: webTimezone });
		const lines: string[] = [];
		const watch = (page: Page): void => {
			page.on('console', m => lines.push(`${new Date().toISOString()} [${m.type()}] ${m.text()}`));
			page.on('pageerror', e => lines.push(`${new Date().toISOString()} [pageerror] ${e.message}`));
		};
		context.on('page', watch);
		// The trace of this context, kept on failure (docs/test-plans/M1-S7.md, Finding F2). The harness records it itself
		// instead of Playwright's `use.trace` (off in playwright.config.ts): the runner merges the test's traces with
		// yauzl, which never finishes on Node 24 once a trace entry is larger than 64 KiB (the real app's bundle, its DOM
		// snapshots), so a failing test hung until its timeout and lost its trace. tracing.stop({ path }) writes the zip
		// without reading one back. No screenshots: the screencast frames are pixels no redaction can reach (C1-R1); DOM
		// snapshots and network bodies are text, which the redacting reporter redacts.
		await context.tracing.start({ screenshots: false, snapshots: true, sources: true, title: testInfo.titlePath.join(' > ') });
		const page = await context.newPage();
		try {
			await use({ context, page, baseURL: stack.webUrl, console: lines });
		} finally {
			if (failed(testInfo)) {
				await attachText(testInfo, 'browser-console.log', redactText(lines.join('\n'), workerSecrets(stack)));
				const path = testInfo.outputPath('trace.zip');
				await context.tracing.stop({ path });
				await testInfo.attach('trace', { path, contentType: 'application/zip' });
			} else {
				await context.tracing.stop();
			}
			await context.close();
		}
	},
});

export { expect };
