// M1-AC19: the harness refuses to run when JOPLIN_SERVER_URL points at anything other than a container it started.
// NEG: https://example.com aborts with a clear message before any request is made. The proof that no request is made
// is a canary: a listener in this process (not a container the harness started) that must see zero connections.
// Positive control: JOPLIN_SERVER_URL naming a server of a stack this harness started is accepted and used.
// docs/test-plans/M1-S6.md.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { join } from 'node:path';
import { checkServerUrl, ForeignServerError } from '../../stack/guard.ts';
import { downStack, newStack, upCore, upDefault } from '../../stack/stack.ts';
import type { StackState } from '../../stack/stack.ts';
import { containerName, podman, readPin, runId, runLabel, testLabel } from '../support/podman.ts';
import { describeRun, runSelftest, stackImagesEnv } from '../support/selftest.ts';
import type { SelftestRun } from '../support/selftest.ts';

const minute = 60_000;

const abortedBeforeAnyTest = (run: SelftestRun, url: string): void => {
	expect({ code: run.code === 0 ? 0 : 'non-zero' }).toEqual({ code: 'non-zero' });
	expect(existsSync(join(run.out, 'body-ran'))).toBe(false);
	const messages = [run.output, ...(run.report?.errors ?? []).map(e => e.message ?? '')].join('\n');
	expect(messages).toContain(`Refusing to run: JOPLIN_SERVER_URL=${url} is not a Joplin Server container started by this test harness`);
	expect(messages).toContain('no request was made');
	expect(messages).toMatch(/aborting before any test runs/);
	// Nothing of a stack was started: no compose project, no image build.
	expect(existsSync(join(run.out, 'stack'))).toBe(false);
};

describe('M1-AC19 real-server guard', () => {
	let canary: Server | undefined;
	let canaryPort = 0;
	const connections: string[] = [];
	let stack: StackState | undefined;

	beforeAll(async () => {
		canary = createServer((socket: Socket) => {
			connections.push(`${socket.remoteAddress}:${socket.remotePort}`);
			socket.destroy();
		});
		await new Promise<void>(resolve => canary?.listen(0, '127.0.0.1', () => resolve()));
		const address = canary.address();
		canaryPort = typeof address === 'object' && address ? address.port : 0;
	});

	afterAll(async () => {
		downStack(stack);
		await new Promise<void>(resolve => (canary ? canary.close(() => resolve()) : resolve()));
	});

	test('ac19-unit the guard accepts only the published port of a running harness server', () => {
		const ours = [{ container: 'nst-x-server-1', project: 'nst-x', run: 'r', url: 'http://127.0.0.1:41000' }];
		expect(checkServerUrl(undefined, () => ours)).toBeUndefined();
		expect(checkServerUrl('', () => ours)).toBeUndefined();
		expect(checkServerUrl('http://127.0.0.1:41000', () => ours)?.container).toBe('nst-x-server-1');
		expect(checkServerUrl('http://localhost:41000/', () => ours)?.container).toBe('nst-x-server-1');
		for (const bad of ['https://example.com', 'http://127.0.0.1:41001', 'https://127.0.0.1:41000', 'http://user:pw@127.0.0.1:41000',
			'http://127.0.0.1:41000/joplin', 'http://192.168.1.10:22300', 'http://joplin.example.com:22300', 'not a url']) {
			expect(() => checkServerUrl(bad, () => ours)).toThrow(ForeignServerError);
		}
		// The message never prints credentials.
		let message = '';
		try {
			checkServerUrl('http://user:hunter2secret@127.0.0.1:41000', () => ours);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('Refusing to run: JOPLIN_SERVER_URL=http://127.0.0.1:41000 ');
		expect(message).not.toContain('hunter2secret');
	});

	test('ac19-neg JOPLIN_SERVER_URL=https://example.com aborts before any test and any stack', () => {
		const run = runSelftest('ac19-neg-example', 'selftest/guard.spec.ts', { JOPLIN_SERVER_URL: 'https://example.com', NOTESTEAD_WEB_IMAGE: 'localhost/never-used:none', NOTESTEAD_HEADLESS_IMAGE: 'localhost/never-used:none', NOTESTEAD_DEVICE_IMAGE: 'localhost/never-used:none' });
		abortedBeforeAnyTest(run, 'https://example.com');
	}, 10 * minute);

	test('ac19-neg-canary a loopback URL that is not a harness container: refused, and the listener there saw no connection', () => {
		const url = `http://127.0.0.1:${canaryPort}`;
		const run = runSelftest('ac19-neg-canary', 'selftest/guard.spec.ts', { JOPLIN_SERVER_URL: url, NOTESTEAD_WEB_IMAGE: 'localhost/never-used:none', NOTESTEAD_HEADLESS_IMAGE: 'localhost/never-used:none', NOTESTEAD_DEVICE_IMAGE: 'localhost/never-used:none' });
		abortedBeforeAnyTest(run, url);
		expect(connections).toEqual([]);
	}, 10 * minute);

	test('ac19-neg-foreign-container a server container the harness did not start is refused', () => {
		// The pinned joplin/server image, started by hand (no stack labels), published on 127.0.0.1.
		const name = containerName({ suite: 'guard', net: '', prefix: '', containers: [], logsDir: '' }, 'foreign');
		const pin = readPin();
		try {
			podman(['run', '-d', '--name', name, '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, '-p', '127.0.0.1::22300',
				'-e', 'APP_PORT=22300', '-e', 'APP_BASE_URL=https://joplin.example.test', '-e', 'JOPLIN_IS_TESTING=1',
				`${pin.server.image}:${pin.server.tag}`, 'node', 'dist/index.js', '--env', 'dev', '--env-file', '/dev/null']);
			const port = podman(['port', name, '22300/tcp']).stdout.trim().split(':').pop() ?? '';
			const url = `http://127.0.0.1:${port}`;
			const run = runSelftest('ac19-neg-foreign', 'selftest/guard.spec.ts', { JOPLIN_SERVER_URL: url, NOTESTEAD_WEB_IMAGE: 'localhost/never-used:none', NOTESTEAD_HEADLESS_IMAGE: 'localhost/never-used:none', NOTESTEAD_DEVICE_IMAGE: 'localhost/never-used:none' });
			abortedBeforeAnyTest(run, url);
		} finally {
			podman(['rm', '-f', '-t', '0', name], { allowFail: true });
		}
	}, 10 * minute);

	test('ac19-pos JOPLIN_SERVER_URL naming a server of a stack this harness started is accepted and used', async () => {
		const images = stackImagesEnv();
		const pin = readPin();
		stack = newStack({ name: 'guardpos', images: {
			server: `${pin.server.image}:${pin.server.tag}`, web: images.NOTESTEAD_WEB_IMAGE, headless: images.NOTESTEAD_HEADLESS_IMAGE,
			device: images.NOTESTEAD_DEVICE_IMAGE, built: [],
		} });
		await upCore(stack);
		await upDefault(stack);
		const run = runSelftest('ac19-pos', 'selftest/guard.spec.ts', { ...images, JOPLIN_SERVER_URL: stack.serverUrl });
		expect({ code: run.code, why: run.code === 0 ? '' : describeRun(run) }).toEqual({ code: 0, why: '' });
		const ran = JSON.parse(readFileSync(join(run.out, 'body-ran'), 'utf8')) as { serverUrl: string; project: string; attached: boolean };
		expect(ran).toEqual({ serverUrl: stack.serverUrl, project: stack.project, attached: true });
		// The inner run attached; it did not tear the stack down.
		expect(podman(['inspect', '--format', '{{.State.Status}}', stack.containers.server ?? '']).stdout.trim()).toBe('running');
	}, 40 * minute);
});
