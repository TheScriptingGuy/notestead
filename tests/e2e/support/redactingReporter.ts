// Playwright reporter that redacts everything a finished test leaves behind, in place, before any other reporter reads
// it (it is listed first in playwright.config.ts; the HTML, JSON and JUnit reporters read results and copy attachments
// only at onEnd, and the `list` reporter prints errors in its onEnd epilogue). ADR-0007/0008, M1-AC20, M1-S6a C1:
// no unredacted token= or credential header value, and no secret the harness knows, in any artifact or report.
// Secrets: the default account's (NOTESTEAD_E2E_STACK) and every secret registered in the run's registry file
// (NOTESTEAD_SECRETS_FILE, tests/support/secrets.ts): per-test passwords, master passwords and Data API tokens.
// - onStepBegin/onStepEnd: the step's title (`Fill "<value>"`, `Type "<text>"`), its titlePath() and its error;
// - onTestEnd: every attachment (the Playwright trace zip entry by entry, error-context, test attachments), the
//   errors (message, stack, value, snippet, cause), the stdout/stderr chunks, the step tree;
//   then, for a test that did not pass, one redacted `[notestead] FAILED …` line on stdout at once (failureLine.ts);
// - onEnd: every file under each project's outputDir (for example the original of an attachment added by path);
// - onExit: the registry file is removed (it must outlive globalSetup's teardown, which Playwright runs before onEnd).
// Markers for the upload gate (M1-S8 C1-R2, tests/support/uploadGate.ts): onBegin writes `redaction-pending.json` next
// to each output dir (in its parent: test-results/e2e/ for playwright.config.ts) listing the run's output dirs and
// report paths, and removes a stale `redaction-complete.json`; onExit, after every reporter's onEnd, writes
// `redaction-complete.json`. A run killed before that has a pending marker only, and the gate removes its outputs.
// The worker redacts its stdout/stderr at the source (fixtures.ts `redactStdio`), because `list` prints those chunks
// live, before any reporter callback could change them.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { FullConfig, Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import { credentialValues, isZip, looksLikeText, redactBuffer, redactFile, redactText, sessionIdsFromTrace, textViews } from '../../support/redact.ts';
import type { KnownSecret } from '../../support/redact.ts';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { mergeSecrets, readSecretsFile, removeSecretsFile, secretFeedEnabled, secretsFileEnv } from '../../support/secrets.ts';
import { completeMarker, pendingMarker } from '../../support/uploadGate.ts';
import { readZip } from '../../support/zip.ts';
import { failureLine } from './failureLine.ts';

const stackSecrets = (): KnownSecret[] => {
	const raw = process.env.NOTESTEAD_E2E_STACK;
	if (!raw) return [];
	try {
		const state = JSON.parse(raw) as { accounts?: { password: string; masterPassword: string }[] };
		return (state.accounts ?? []).flatMap((a, i) => [
			{ label: `account${i}_password`, value: a.password },
			{ label: `account${i}_master_password`, value: a.masterPassword },
		]);
	} catch {
		return [];
	}
};

const filesUnder = (dir: string): string[] => {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap(name => {
		const path = join(dir, name);
		try {
			return statSync(path).isDirectory() ? filesUnder(path) : [path];
		} catch {
			return [];
		}
	});
};

// The files and folders the run's other reporters write (html, junit, json, blob), resolved as Playwright resolves
// them: relative to the config file's directory.
const reportPaths = (config: FullConfig): string[] => {
	const base = config.configFile ? dirname(config.configFile) : process.cwd();
	const out: string[] = [];
	for (const entry of config.reporter ?? []) {
		const [name, options] = (Array.isArray(entry) ? entry : [entry, undefined]) as [string, Record<string, unknown> | undefined];
		const opt = (key: string): string | undefined => (typeof options?.[key] === 'string' ? options[key] as string : undefined);
		if (name === 'html') out.push(resolve(base, opt('outputFolder') ?? 'playwright-report'));
		else if (name === 'blob') out.push(resolve(base, opt('outputDir') ?? 'blob-report'));
		else if (name === 'junit' || name === 'json') {
			const file = opt('outputFile');
			if (file) out.push(resolve(base, file));
		}
	}
	return out;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export default class RedactingReporter implements Reporter {
	private known: KnownSecret[] = [];
	private fileSize = -1;
	private outputDirs: string[] = [];
	private markerDirs: string[] = [];
	private ended = false;
	private redactedFiles = 0;
	// The registry file of this run (globalSetup, in this same runner process, sets it before any test starts).
	private secretsFile(): string | undefined {
		return process.env[secretsFileEnv];
	}

	// Everything known so far: the cumulative list survives the registry file (removed in onExit). The file is read
	// again only when its size changed (onStepEnd runs for every step).
	private secrets(): KnownSecret[] {
		const file = this.secretsFile();
		let size = -1;
		try {
			size = file ? statSync(file).size : -1;
		} catch {
			size = -1;
		}
		if (size !== this.fileSize || this.known.length === 0) {
			this.fileSize = size;
			this.known = mergeSecrets(this.known, stackSecrets(), readSecretsFile(file));
		}
		return this.known;
	}

	private redactError(error: TestError | undefined, secrets: KnownSecret[], depth = 0): void {
		if (!error || depth > 5) return;
		const e = error as Mutable<TestError>;
		if (e.message) e.message = redactText(e.message, secrets);
		if (e.stack) e.stack = redactText(e.stack, secrets);
		if (e.value) e.value = redactText(e.value, secrets);
		if (e.snippet) e.snippet = redactText(e.snippet, secrets);
		this.redactError(e.cause, secrets, depth + 1);
	}

	private wrapped = new WeakSet<TestStep>();

	// The title, its titlePath() (the runner's closure returns the original titles) and the error.
	private redactStep(step: TestStep, secrets: KnownSecret[]): void {
		const s = step as Mutable<TestStep>;
		s.title = redactText(s.title, secrets);
		if (!this.wrapped.has(step) && typeof s.titlePath === 'function') {
			this.wrapped.add(step);
			const original = s.titlePath.bind(step);
			s.titlePath = () => original().map(t => redactText(t, this.secrets()));
		}
		this.redactError(s.error, secrets);
		for (const child of s.steps) this.redactStep(child, secrets);
	}

	private redactChunks(chunks: (string | Buffer)[], secrets: KnownSecret[]): void {
		for (let i = 0; i < chunks.length; i++) {
			const c = chunks[i];
			if (typeof c === 'string') chunks[i] = redactText(c, secrets);
			else if (looksLikeText(c)) chunks[i] = Buffer.from(redactText(c.toString('utf8'), secrets), 'utf8');
		}
	}

	// A v1 reporter gets the config here (Playwright's v2 wrapper does not forward onConfigure).
	public onBegin(config: FullConfig): void {
		this.outputDirs = [...new Set(config.projects.map(p => p.outputDir))];
		this.markerDirs = [...new Set(this.outputDirs.map(d => dirname(d)))];
		const paths = [...this.outputDirs, ...reportPaths(config)];
		for (const dir of this.markerDirs) {
			mkdirSync(dir, { recursive: true });
			rmSync(join(dir, completeMarker), { force: true });
			writeFileSync(join(dir, pendingMarker), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), paths }, null, 2)}\n`);
		}
	}

	public onStepBegin(_test: TestCase, _result: TestResult, step: TestStep): void {
		this.redactStep(step, this.secrets());
	}

	public onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
		this.redactStep(step, this.secrets());
	}

	// Credentials the browser obtained itself (a session id sent as X-API-AUTH) are known to no registry: they are
	// learnt from the request headers in each trace's network log and from the bodies of its …/api/sessions responses
	// (M1-S8 C1-R1b), before anything is redacted, and from then on
	// redacted like a registered secret, in every entry, attachment and output file (M1-S7 F3, C1-R1). Part of the
	// secret feed, so the self-tests' negative control (feed off) still sees them.
	private learnFromTraces(attachments: { path?: string; body?: Buffer }[]): void {
		if (!secretFeedEnabled()) return;
		const learnt: KnownSecret[] = [];
		for (const attachment of attachments) {
			let data: Buffer | undefined;
			try {
				data = attachment.path ? readFileSync(attachment.path) : attachment.body;
			} catch {
				data = undefined;
			}
			if (!data || !isZip(data)) continue;
			try {
				for (const view of textViews('trace', data)) {
					for (const value of credentialValues(view.text)) learnt.push({ label: 'credential_header_value', value });
				}
				// Session ids the server returned in a login response body, sent later or not (M1-S8 C1-R1b).
				for (const value of sessionIdsFromTrace(readZip(data))) learnt.push({ label: 'session_id', value });
			} catch {
				// an unreadable zip is dropped by the redaction below
			}
		}
		if (learnt.length > 0) this.known = mergeSecrets(this.known, learnt);
	}

	public onTestEnd(test: TestCase, result: TestResult): void {
		this.secrets(); // the registry first: learnFromTraces adds to what it loaded
		this.learnFromTraces(result.attachments as { path?: string; body?: Buffer }[]);
		const secrets = this.secrets();
		for (const attachment of result.attachments as { path?: string; body?: Buffer }[]) {
			try {
				if (attachment.path) redactFile(attachment.path, secrets);
				if (attachment.body) attachment.body = redactBuffer(attachment.body, secrets);
			} catch (error) {
				// An attachment that cannot be redacted is not kept.
				process.stderr.write(`redacting reporter: dropping an attachment it could not redact (${(error as Error).message})\n`);
				if (attachment.path) rmSync(attachment.path, { force: true });
				attachment.path = undefined;
				attachment.body = Buffer.from('[attachment removed: it could not be redacted]');
			}
		}
		for (const error of result.errors) this.redactError(error, secrets);
		this.redactError(result.error, secrets);
		this.redactChunks(result.stdout, secrets);
		this.redactChunks(result.stderr, secrets);
		for (const step of result.steps) this.redactStep(step, secrets);
		this.printFailure(test, result, secrets);
	}

	// One redacted line per failure, at once: `list` prints error details only at the end of the run, and a run killed by
	// its step limit never gets there (docs/test-plans/CI-M2-S2-x64-arm64.md Decisions C, D). It is a diagnostic: whatever
	// goes wrong while building it (the unit tests call onTestEnd with partial objects) must never stop the redaction.
	private printFailure(test: TestCase, result: TestResult, secrets: KnownSecret[]): void {
		if (typeof result.status !== 'string' || result.status === 'passed' || result.status === 'skipped') return;
		try {
			process.stdout.write(`${failureLine({
				title: test.titlePath().slice(-1)[0] ?? test.title,
				file: relative(findRepoRoot(), test.location.file),
				line: test.location.line,
				retry: result.retry,
				status: result.status,
				durationMs: result.duration,
				error: result.error?.message ?? result.status,
			}, secrets)}\n`);
		} catch {
			// not a line this time
		}
	}

	public onEnd(): void {
		const secrets = this.secrets();
		for (const dir of this.outputDirs) {
			for (const file of filesUnder(dir)) {
				try {
					redactFile(file, secrets);
					this.redactedFiles++;
				} catch (error) {
					process.stderr.write(`redacting reporter: removing a file it could not redact (${(error as Error).message})\n`);
					rmSync(file, { force: true });
				}
			}
		}
		this.ended = true;
	}

	// After every reporter's onEnd (the HTML, JUnit and JSON reports are written): the run's redaction is complete.
	public async onExit(): Promise<void> {
		removeSecretsFile(this.secretsFile());
		if (!this.ended) return;
		for (const dir of this.markerDirs) {
			writeFileSync(join(dir, completeMarker), `${JSON.stringify({ complete: true, finishedAt: new Date().toISOString(), redactedFiles: this.redactedFiles }, null, 2)}\n`);
		}
	}

	public printsToStdio(): boolean {
		return false;
	}
}
