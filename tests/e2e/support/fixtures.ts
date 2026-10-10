// Playwright fixtures of the Notestead harness (ADR-0007 §Fixtures and isolation; docs/test-plans/M1-S6.md):
//   worker  stack         the compose test stack globalSetup started (or attached to), read from NOTESTEAD_E2E_STACK
//           joplinServer  that stack's throwaway Joplin Server: direct URL, the proxied URL through web, a request helper
//   test    e2eeAccount   a fresh server user whose E2EE "other device" turned E2EE on and seeded a folder and a note
//           headlessService  a fresh headless service (own compose project, own profile volume) for that account,
//                         healthy (ADR-0007's `headless`; Playwright reserves the name `headless` for its own option)
//           dataApi       GET on that headless service's Data API, from inside its network namespace (never published)
//           webApp        a fresh BrowserContext (fresh OPFS and service worker) on the web container, 127.0.0.1 origin
//           stackLogs     (auto) on failure attaches the server, web and default supervisor logs of the test's time span
// Every attachment is redacted before it is written (tests/support/redact.ts); the redacting reporter then redacts the
// Playwright trace and any other attachment file once more (tests/e2e/support/redactingReporter.ts).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base } from '@playwright/test';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { checkServerUrl } from '../../stack/guard.ts';
import {
	containerLog, createAccount, downHeadless, enableE2ee, secretsFor, serverRequest, upHeadless,
} from '../../stack/stack.ts';
import type { Account, HeadlessService, StackState } from '../../stack/stack.ts';
import type { HttpResponse } from '../../contract/support/http.ts';
import { redactText } from '../../support/redact.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { stackEnv } from './globalSetup.ts';

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
}

interface TestFixtures {
	stackLogs: undefined;
	e2eeAccount: Account;
	headlessService: HeadlessService;
	dataApi: DataApi;
	webApp: WebApp;
}

const failed = (testInfo: TestInfo): boolean => testInfo.status !== testInfo.expectedStatus;

// Writes `text` (already redacted) into the test's output dir and attaches it by path.
export const attachText = async (testInfo: TestInfo, name: string, text: string): Promise<void> => {
	const path = testInfo.outputPath(name);
	writeFileSync(path, text);
	await testInfo.attach(name, { path, contentType: 'text/plain' });
};

const shortId = (testInfo: TestInfo): string => `${testInfo.testId.slice(0, 8)}${testInfo.retry ? `r${testInfo.retry}` : ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');

// The M1-S5 in-container Data API probe, piped to `node -` on stdin: no test files are mounted into the headless
// container, and the token never leaves it.
const dataApiProbe = (): string => readFileSync(join(findRepoRoot(), 'tests', 'fixtures', 'm1-s5', 'in-container', 'data-api.mjs'), 'utf8');

export const test = base.extend<TestFixtures, WorkerFixtures>({
	// eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a destructured object
	stack: [async ({}, use) => {
		// The guard again, in the worker: a worker can be started with a different environment than globalSetup.
		checkServerUrl(process.env.JOPLIN_SERVER_URL);
		const raw = process.env[stackEnv];
		if (!raw) throw new Error(`${stackEnv} is not set: run Playwright with playwright.config.ts (its globalSetup starts the stack)`);
		// Workers never own the stack: globalSetup's teardown removes it, and only that process writes its descriptor.
		await use({ ...JSON.parse(raw) as StackState, owned: false });
	}, { scope: 'worker' }],

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
		const secrets = secretsFor(stack);
		if (stack.containers.server) await attachText(testInfo, 'server.log', containerLog(stack, stack.containers.server, since, secrets));
		if (stack.containers.web) await attachText(testInfo, 'web.log', containerLog(stack, stack.containers.web, since, secrets));
		if (stack.defaultHeadless?.container) await attachText(testInfo, 'supervisor-default.log', containerLog(stack, stack.defaultHeadless.container, since, secrets));
	}, { auto: true }],

	e2eeAccount: async ({ stack }, use, testInfo) => {
		const account = enableE2ee(stack, await createAccount(stack), shortId(testInfo));
		await use(account);
	},

	headlessService: async ({ stack, e2eeAccount }, use, testInfo) => {
		let service: HeadlessService | undefined;
		try {
			service = await upHeadless(stack, e2eeAccount, shortId(testInfo));
			await use(service);
		} finally {
			if (service?.container && failed(testInfo)) await attachText(testInfo, 'supervisor.log', containerLog(stack, service.container));
			downHeadless(stack, service);
		}
	},

	dataApi: async ({ headlessService }, use) => {
		const probe = dataApiProbe();
		await use({
			get: (path: string): DataApiResult => {
				const r = spawnSync('podman', ['exec', '-i', headlessService.container, 'node', '-', path], { input: probe, encoding: 'utf8', timeout: 120_000 });
				const line = (r.stdout ?? '').split('\n').filter(l => l.startsWith('RESULT ')).pop();
				if (!line) return { error: `data-api probe printed no result (exit ${r.status}): ${redactText(`${r.stdout}\n${r.stderr}`).slice(-1000)}` };
				return JSON.parse(line.slice('RESULT '.length)) as DataApiResult;
			},
		});
	},

	webApp: async ({ browser, stack }, use, testInfo) => {
		if (!stack.webUrl) throw new Error('the stack has no web URL');
		// 127.0.0.1, never localhost: upstream's environment.js turns on dev mode for any origin containing "localhost".
		const context = await browser.newContext({ baseURL: stack.webUrl });
		const lines: string[] = [];
		const watch = (page: Page): void => {
			page.on('console', m => lines.push(`${new Date().toISOString()} [${m.type()}] ${m.text()}`));
			page.on('pageerror', e => lines.push(`${new Date().toISOString()} [pageerror] ${e.message}`));
		};
		context.on('page', watch);
		const page = await context.newPage();
		try {
			await use({ context, page, baseURL: stack.webUrl, console: lines });
		} finally {
			if (failed(testInfo)) await attachText(testInfo, 'browser-console.log', redactText(lines.join('\n'), secretsFor(stack)));
			await context.close();
		}
	},
});

export { expect } from '@playwright/test';
