// Playwright reporter that redacts everything a finished test leaves behind, in place, before any other reporter reads
// it (it is listed first in playwright.config.ts; the HTML, JSON and JUnit reporters read results and copy attachments
// only at onEnd, and the `list` reporter prints errors in its onEnd epilogue). ADR-0007/0008, M1-AC20, M1-S6a C1:
// no unredacted token= or credential header value, and no secret the harness knows, in any artifact or report.
// Secrets: the default account's (NOTESTEAD_E2E_STACK) and every secret registered in the run's registry file
// (NOTESTEAD_SECRETS_FILE, tests/support/secrets.ts): per-test passwords, master passwords and Data API tokens.
// - onStepBegin/onStepEnd: the step's title (`Fill "<value>"`, `Type "<text>"`), its titlePath() and its error;
// - onTestEnd: every attachment (the Playwright trace zip entry by entry, error-context, test attachments), the
//   errors (message, stack, value, snippet, cause), the stdout/stderr chunks, the step tree;
// - onEnd: every file under each project's outputDir (for example the original of an attachment added by path);
// - onExit: the registry file is removed (it must outlive globalSetup's teardown, which Playwright runs before onEnd).
// The worker redacts its stdout/stderr at the source (fixtures.ts `redactStdio`), because `list` prints those chunks
// live, before any reporter callback could change them.
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig, Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import { credentialValues, isZip, looksLikeText, redactBuffer, redactFile, redactText, textViews } from '../../support/redact.ts';
import type { KnownSecret } from '../../support/redact.ts';
import { mergeSecrets, readSecretsFile, removeSecretsFile, secretFeedEnabled, secretsFileEnv } from '../../support/secrets.ts';

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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export default class RedactingReporter implements Reporter {
	private known: KnownSecret[] = [];
	private fileSize = -1;
	private outputDirs: string[] = [];
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
	}

	public onStepBegin(_test: TestCase, _result: TestResult, step: TestStep): void {
		this.redactStep(step, this.secrets());
	}

	public onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
		this.redactStep(step, this.secrets());
	}

	// Credentials the browser obtained itself (a session id sent as X-API-AUTH) are known to no registry: they are
	// learnt from the request headers in each trace's network log, before anything is redacted, and from then on
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
			} catch {
				// an unreadable zip is dropped by the redaction below
			}
		}
		if (learnt.length > 0) this.known = mergeSecrets(this.known, learnt);
	}

	public onTestEnd(_test: TestCase, result: TestResult): void {
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
	}

	public onEnd(): void {
		const secrets = this.secrets();
		for (const dir of this.outputDirs) {
			for (const file of filesUnder(dir)) {
				try {
					redactFile(file, secrets);
				} catch (error) {
					process.stderr.write(`redacting reporter: removing a file it could not redact (${(error as Error).message})\n`);
					rmSync(file, { force: true });
				}
			}
		}
	}

	public async onExit(): Promise<void> {
		removeSecretsFile(this.secretsFile());
	}

	public printsToStdio(): boolean {
		return false;
	}
}
