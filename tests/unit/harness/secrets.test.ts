// Unit tests of the harness's secret registry, stdio redaction and redacting reporter (tests/support/secrets.ts,
// tests/e2e/support/redactingReporter.ts; docs/test-plans/M1-S6a.md, C1 layer "unit"). The C1 contract self-test proves
// the same on a real Playwright run; these pin the rules cheaply. Every test uses its own temp dir and environment.
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import RedactingReporter from '../../e2e/support/redactingReporter.ts';
import { readZip, writeZip } from '../../support/zip.ts';
import {
	createSecretsFile, installStdioRedaction, mergeSecrets, readSecretsFile, registerSecrets, registeredSecrets, removeSecretsFile,
	secretFeedEnabled, secretsFileEnv,
} from '../../support/secrets.ts';

const envKeys = [secretsFileEnv, 'NST_SELFTEST_OUT', 'NST_SELFTEST_SECRET_FEED', 'NOTESTEAD_E2E_STACK'];

describe('harness secret registry and redacting reporter', () => {
	let saved: Record<string, string | undefined>;
	let work: string;

	beforeEach(() => {
		saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
		for (const k of envKeys) delete process.env[k];
		work = mkdtempSync(join(tmpdir(), 'nst-unit-secrets-'));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(work, { recursive: true, force: true });
	});

	test('registered secrets go to memory and, when a registry file is set, to that 0600 file once each', () => {
		const file = createSecretsFile();
		try {
			expect(process.env[secretsFileEnv]).toBe(file);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			registerSecrets([{ label: 'unit_pw', value: 'unit-secret-one-1a2b' }, { label: 'short', value: 'abc' }]);
			registerSecrets([{ label: 'unit_pw_again', value: 'unit-secret-one-1a2b' }, { label: 'unit_tok', value: 'unit-secret-two-3c4d' }]);
			expect(readSecretsFile(file)).toEqual([{ label: 'unit_pw', value: 'unit-secret-one-1a2b' }, { label: 'unit_tok', value: 'unit-secret-two-3c4d' }]);
			expect(registeredSecrets().map(s => s.value)).toEqual(expect.arrayContaining(['unit-secret-one-1a2b', 'unit-secret-two-3c4d']));
			expect(registeredSecrets().some(s => s.value === 'abc')).toBe(false);
		} finally {
			removeSecretsFile(file);
		}
		expect(existsSync(file)).toBe(false);
	});

	test('a malformed registry line is skipped, and removeSecretsFile only removes a registry dir', () => {
		const file = join(work, 'secrets.jsonl');
		writeFileSync(file, `${JSON.stringify({ label: 'a', value: 'value-number-one' })}\n{"label":"b","val\n${JSON.stringify({ label: 'c', value: 'value-number-two' })}\n`);
		expect(readSecretsFile(file).map(s => s.label)).toEqual(['a', 'c']);
		removeSecretsFile(file);
		expect(existsSync(file)).toBe(true);
	});

	test('the C1 negative-control switch works in self-test runs only', () => {
		process.env.NST_SELFTEST_SECRET_FEED = 'off';
		expect(secretFeedEnabled()).toBe(true);
		process.env.NST_SELFTEST_OUT = work;
		expect(secretFeedEnabled()).toBe(false);
		const file = createSecretsFile();
		try {
			registerSecrets([{ label: 'off', value: 'never-registered-5e6f' }]);
			expect(readSecretsFile(file)).toEqual([]);
		} finally {
			removeSecretsFile(file);
		}
	});

	test('mergeSecrets drops duplicates and puts longer values first', () => {
		const merged = mergeSecrets([{ label: 'a', value: 'abcdef' }], [{ label: 'b', value: 'abcdefgh' }, { label: 'c', value: 'abcdef' }]);
		expect(merged).toEqual([{ label: 'b', value: 'abcdefgh' }, { label: 'a', value: 'abcdef' }]);
	});

	test('stdout and stderr chunks are redacted before they reach the previous write function, and restored after', () => {
		const out: unknown[] = [];
		const original = { stdout: process.stdout.write, stderr: process.stderr.write };
		const sink = ((chunk: unknown) => {
			out.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stdout.write = sink;
		process.stderr.write = sink;
		try {
			const restore = installStdioRedaction(() => [{ label: 'stdio_secret', value: 'stdio-secret-7a8b' }]);
			process.stdout.write('one stdio-secret-7a8b\n');
			process.stderr.write(Buffer.from('two stdio-secret-7a8b ?token=t0k3n\n'));
			process.stdout.write(Buffer.from([0, 1, 2]));
			restore();
			process.stdout.write('three stdio-secret-7a8b\n');
			expect(out.map(c => (typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString('latin1')))).toEqual([
				'one [stdio_secret]\n', 'two [stdio_secret] ?token=[REDACTED]\n', '\u0000\u0001\u0002', 'three stdio-secret-7a8b\n',
			]);
			expect(process.stdout.write).toBe(sink);
		} finally {
			process.stdout.write = original.stdout;
			process.stderr.write = original.stderr;
		}
	});

	const secret = 'per-test-secret-9c0d Δ$x!';
	// As the runner builds them: titlePath() is a closure over the original title.
	const step = (title: string, error?: string, steps: TestStep[] = []): TestStep => ({ title, titlePath: () => [title], error: error ? { message: error } : undefined, steps } as unknown as TestStep);

	const fakeResult = (attachmentFile: string, traceFile: string): TestResult => ({
		errors: [{ message: `Received: "${secret}"`, stack: `Error: ${secret}\n at x`, cause: { message: `cause ${secret}` } }],
		stdout: [`out ${secret}\n`, Buffer.from(`buf ${secret}\n`)],
		stderr: [`err ${JSON.stringify(secret).slice(1, -1)}\n`],
		steps: [step(`Fill "${secret}"`, undefined, [step('inner', `inner ${secret}`)])],
		attachments: [
			{ name: 'body', contentType: 'text/plain', body: Buffer.from(`body ${secret}`) },
			{ name: 'file', contentType: 'text/plain', path: attachmentFile },
			{ name: 'trace', contentType: 'application/zip', path: traceFile },
		],
	} as unknown as TestResult);

	const run = (withRegistry: boolean): { result: TestResult; stray: string; trace: string; reporter: RedactingReporter; file?: string } => {
		const outputDir = join(work, 'output');
		const attachmentFile = join(work, 'attachment.txt');
		const stray = join(outputDir, 'test-a', 'original.txt');
		const trace = join(outputDir, 'test-a', 'trace.zip');
		mkdirSync(join(outputDir, 'test-a'), { recursive: true });
		writeFileSync(attachmentFile, `file ${secret}`);
		writeFileSync(stray, `stray ${secret}`);
		writeFileSync(trace, writeZip([{ name: '0-trace.trace', data: Buffer.from(`${JSON.stringify({ method: 'fill', params: { value: secret } })}\n`) }]));
		let file: string | undefined;
		if (withRegistry) {
			file = createSecretsFile();
			registerSecrets([{ label: 'pertest_secret', value: secret }]);
		}
		const reporter = new RedactingReporter();
		reporter.onBegin({ projects: [{ outputDir }] } as unknown as FullConfig);
		const result = fakeResult(attachmentFile, trace);
		reporter.onStepBegin({} as TestCase, result, result.steps[0]);
		reporter.onStepEnd({} as TestCase, result, result.steps[0].steps[0]);
		reporter.onTestEnd({} as TestCase, result);
		reporter.onEnd();
		return { result, stray, trace, reporter, file };
	};

	const dump = (r: TestResult, stray: string, trace: string): string => [
		JSON.stringify({ errors: r.errors, steps: r.steps, stdout: r.stdout.map(String), stderr: r.stderr.map(String) }),
		...(r.attachments as { body?: Buffer; path?: string }[]).map(a => (a.body ? a.body.toString('utf8') : '')),
		readFileSync(join(work, 'attachment.txt'), 'utf8'),
		readFileSync(stray, 'utf8'),
		...readZip(readFileSync(trace)).map(e => e.data.toString('utf8')),
	].join('\n');

	test('the reporter redacts a registered per-test secret in errors, causes, stdout/stderr, steps, attachments, trace and stray output files', async () => {
		const { result, stray, trace, reporter, file } = run(true);
		const all = dump(result, stray, trace);
		expect(all).not.toContain('per-test-secret-9c0d');
		expect(all).toContain('[pertest_secret]');
		expect(result.steps[0].title).toBe('Fill "[pertest_secret]"');
		expect(result.steps[0].titlePath()).toEqual(['Fill "[pertest_secret]"']);
		await reporter.onExit();
		expect(file && existsSync(file)).toBe(false);
	});

	test('negative control: without the registry the same secret survives (the check above can fail)', () => {
		const { result, stray, trace } = run(false);
		const all = dump(result, stray, trace);
		expect(all.split('per-test-secret-9c0d').length - 1).toBeGreaterThanOrEqual(10);
	});
});
