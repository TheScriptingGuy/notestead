// Playwright globalSetup (docs/test-plans/M1-S6.md §Playwright harness): before any test runs,
//   1. the real-server guard (M1-AC19): a JOPLIN_SERVER_URL that is not a server this harness started aborts the run
//      before a single request is made; one that is attaches to that stack (reuse mode, never torn down here);
//   2. otherwise the compose test stack comes up: server and web, a default E2EE account and its headless service,
//      every service `healthy` (M1-AC18), or the run aborts naming the service;
//   3. the stack's state goes to the workers in NOTESTEAD_E2E_STACK;
//   4. the run's secret registry (NOTESTEAD_SECRETS_FILE, tests/support/secrets.ts) holds the default account's
//      passwords and its Data API token; the workers append every per-test secret (M1-S6a C1). The redacting reporter
//      removes the registry in onExit: Playwright runs this teardown before the reporters' onEnd.
// The returned function is the global teardown: logs written, everything the run created removed.
import { accountSecrets, downStack, newStack, registerToken, upCore, upDefault } from '../../stack/stack.ts';
import type { StackState } from '../../stack/stack.ts';
import { join } from 'node:path';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { createSecretsFile, registerSecrets } from '../../support/secrets.ts';

export const stackEnv = 'NOTESTEAD_E2E_STACK';

const globalSetup = async (): Promise<() => Promise<void>> => {
	const resultsRoot = process.env.NST_SELFTEST_OUT ?? join(findRepoRoot(), 'test-results', 'e2e');
	let state: StackState | undefined;
	createSecretsFile();
	try {
		state = newStack({ name: 'e2e', logsDir: join(resultsRoot, 'stack') });
		if (state.owned) {
			await upCore(state);
			await upDefault(state);
		}
		// An attached stack's secrets too (reuse mode): its accounts and its default service's token.
		for (const account of state.accounts) registerSecrets(accountSecrets(account));
		if (state.defaultHeadless) registerToken(state.defaultHeadless);
	} catch (error) {
		downStack(state);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Notestead test harness: aborting before any test runs.\n${message}`);
	}
	process.env[stackEnv] = JSON.stringify(state);
	const owned = state;
	return async () => {
		downStack(owned);
	};
};

export default globalSetup;
