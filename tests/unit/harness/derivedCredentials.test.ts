// Unit tests of C1-R1's derived credentials (docs/test-plans/M1-S7.md, Finding F3): a credential the browser obtains
// itself (the Joplin Server session id that POST /api/sessions returns and every later request sends as X-API-AUTH) is
// known to no registry. The header redaction removes it from the headers, but the trace also keeps the login
// response body (`resources/<sha1>.json`: {"id": "<session id>", …}). The redacting reporter must learn the values
// of the credential headers in a trace's network log and redact them everywhere: in the trace's other entries, in
// the other attachments and in the output files. The C1-R1 contract self-test proves the same on the real flow.
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import RedactingReporter from '../../e2e/support/redactingReporter.ts';
import { readZip, writeZip } from '../../support/zip.ts';
import { secretsFileEnv } from '../../support/secrets.ts';

const envKeys = [secretsFileEnv, 'NST_SELFTEST_OUT', 'NST_SELFTEST_SECRET_FEED', 'NOTESTEAD_E2E_STACK'];
const session = 'Sx7QpL2mN9vR4tK8wZ1yB3';
const bearer = 'bearer-token-5f2e9a71c4';

describe('redacting reporter: credentials derived from a trace', () => {
	let saved: Record<string, string | undefined>;
	let work: string;

	beforeEach(() => {
		saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
		for (const k of envKeys) delete process.env[k];
		work = mkdtempSync(join(tmpdir(), 'nst-unit-derived-'));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(work, { recursive: true, force: true });
	});

	// A trace as Playwright writes it for the web app's login: the request with its credential headers in `.network`,
	// the login response body as a resource, and the session id again in a console line of `.trace`.
	const run = (): { all: string } => {
		const outputDir = join(work, 'output');
		const dir = join(outputDir, 'test-a');
		mkdirSync(dir, { recursive: true });
		const network = {
			type: 'resource-snapshot',
			snapshot: {
				request: {
					url: 'http://127.0.0.1:1/joplin-server/api/items/root:/info.json:/content',
					headers: [{ name: 'X-API-AUTH', value: session }, { name: 'Authorization', value: `Bearer ${bearer}` }],
				},
				response: { status: 200, content: { _sha1: 'login.json' } },
			},
		};
		const trace = join(dir, 'trace.zip');
		writeFileSync(trace, writeZip([
			{ name: 'trace.network', data: Buffer.from(`${JSON.stringify(network)}\n`) },
			{ name: 'resources/login.json', data: Buffer.from(JSON.stringify({ id: session, user_id: 'u1' })) },
			{ name: 'trace.trace', data: Buffer.from(`${JSON.stringify({ type: 'console', text: `session ${session} token ${bearer}` })}\n`) },
		]));
		const consoleLog = join(dir, 'browser-console.log');
		writeFileSync(consoleLog, `[log] logged in with session ${session}\n`);
		const stray = join(dir, 'stray.txt');
		writeFileSync(stray, `stray ${session} ${bearer}\n`);
		const result = {
			errors: [], stdout: [], stderr: [], steps: [],
			attachments: [
				{ name: 'browser-console.log', contentType: 'text/plain', path: consoleLog },
				{ name: 'trace', contentType: 'application/zip', path: trace },
			],
		} as unknown as TestResult;
		const reporter = new RedactingReporter();
		reporter.onBegin({ projects: [{ outputDir }] } as unknown as FullConfig);
		reporter.onTestEnd({} as TestCase, result);
		reporter.onEnd();
		return {
			all: [
				...readZip(readFileSync(trace)).map(e => e.data.toString('utf8')),
				readFileSync(consoleLog, 'utf8'),
				readFileSync(stray, 'utf8'),
			].join('\n'),
		};
	};

	test('c1r1-derived the session id and bearer token seen in request headers are redacted in every entry, attachment and output file', () => {
		const { all } = run();
		expect({ session: all.includes(session), bearer: all.includes(bearer) }).toEqual({ session: false, bearer: false });
	});

	test('c1r1-derived-neg with the secret feed off (self-test NEG switch), the derived values survive outside the headers', () => {
		process.env.NST_SELFTEST_OUT = work;
		process.env.NST_SELFTEST_SECRET_FEED = 'off';
		const { all } = run();
		// The header pairs themselves are always redacted; the body, the console and the stray file keep the values.
		expect(all.split(session).length - 1).toBeGreaterThanOrEqual(3);
	});
});
