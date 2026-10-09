// Developer CLI for the compose test stack (docs/test-plans/M1-S6.md §How to run). Runs with Node's type stripping:
//   node tests/stack/cli.ts up      start server, web, one E2EE account and its headless service; print the
//                                   JOPLIN_SERVER_URL that the harness accepts for this stack (reuse mode, M1-AC19)
//   node tests/stack/cli.ts down <project>
// Images come from NOTESTEAD_WEB_IMAGE / NOTESTEAD_HEADLESS_IMAGE / NOTESTEAD_DEVICE_IMAGE or are built (images.ts).
// Throwaway values only: the stack is a test fixture, never the user's server.
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downStack, newStack, upCore, upDefault } from './stack.ts';
import type { StackState } from './stack.ts';

const [command, project] = process.argv.slice(2);

const main = async (): Promise<void> => {
	if (command === 'up') {
		const state = newStack({ name: 'dev' });
		try {
			await upCore(state);
			await upDefault(state);
		} catch (error) {
			downStack(state);
			throw error;
		}
		process.stdout.write(`project: ${state.project}\nweb: ${state.webUrl}\nJOPLIN_SERVER_URL=${state.serverUrl}\n`);
		process.stdout.write(`stop with: node tests/stack/cli.ts down ${state.project}\n`);
	} else if (command === 'down' && project) {
		const file = join(tmpdir(), 'notestead-stacks', `${project}.json`);
		if (!existsSync(file)) throw new Error(`no stack descriptor ${file}`);
		downStack({ ...JSON.parse(readFileSync(file, 'utf8')) as StackState, owned: true });
	} else {
		throw new Error('usage: node tests/stack/cli.ts up | down <project>');
	}
};

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
