// Leak scans over everything an inner Playwright run wrote (the harness self-tests of M1-S6a C1 and M1-S7 C1-R1;
// docs/test-plans/M1-S6a.md, docs/test-plans/M1-S7.md). The views are the text a person or a CI artifact would see:
// the JSON report's results (errors, stdout/stderr, steps, attachments), the trace zip entry by entry, the JUnit and HTML
// reports (the HTML report's data zip decoded from index.html), the console log, and every file under the run's dir.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findLeaks, textViews } from '../../support/redact.ts';
import type { KnownSecret, Leak } from '../../support/redact.ts';
import type { PwAttachment, SelftestRun } from './selftest.ts';

// Every password the harness generates (tests/stack/stack.ts strongPassword), of any account of the run.
export const harnessPassword = /nst(pw|mp)[0-9a-f]{24}/;

export interface JsonOutput {
	text?: string;
	buffer?: string;
}

export interface JsonError {
	message?: string;
	stack?: string;
	value?: string;
	snippet?: string;
}

export interface JsonStep {
	title: string;
	error?: JsonError;
	steps?: JsonStep[];
}

export interface JsonResult {
	status: string;
	errors: JsonError[];
	error?: JsonError;
	stdout: JsonOutput[];
	stderr: JsonOutput[];
	steps?: JsonStep[];
	attachments: PwAttachment[];
}

export interface View {
	where: string;
	text: string;
}

// The HTML report keeps its data in a base64 zip inside index.html.
export const htmlReportViews = (dir: string): View[] => {
	const index = join(dir, 'index.html');
	if (!existsSync(index)) return [];
	const m = /<template id="playwrightReportBase64">data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(readFileSync(index, 'utf8'));
	return m ? textViews('html report', Buffer.from(m[1], 'base64')) : [];
};

export const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap(name => {
	const path = join(dir, name);
	return statSync(path).isDirectory() ? filesUnder(path) : [path];
}) : []);

export const outputText = (o: JsonOutput): string => o.text ?? Buffer.from(o.buffer ?? '', 'base64').toString('utf8');
export const errorText = (e: JsonError | undefined): string => (e ? [e.message, e.stack, e.value, e.snippet].filter(Boolean).join('\n') : '');
export const flatSteps = (steps: JsonStep[] = []): JsonStep[] => steps.flatMap(s => [s, ...flatSteps(s.steps)]);
export const attachmentContent = (a: PwAttachment): Buffer => (a.path ? (existsSync(a.path) ? readFileSync(a.path) : Buffer.alloc(0)) : Buffer.from(a.body ?? '', 'base64'));

// The text views per channel of one inner run.
export const channelViews = (run: SelftestRun, result: JsonResult | undefined): Record<'trace' | 'console' | 'stdout' | 'errors' | 'steps' | 'attachments' | 'reports', View[]> => {
	const attachments = result?.attachments ?? [];
	return {
		trace: attachments.filter(a => a.name === 'trace').flatMap(a => textViews('trace', attachmentContent(a))),
		console: existsSync(run.log) ? [{ where: 'playwright-console.log', text: readFileSync(run.log, 'utf8') }] : [],
		stdout: [
			...(result?.stdout ?? []).map((o, i) => ({ where: `stdout[${i}]`, text: outputText(o) })),
			...(result?.stderr ?? []).map((o, i) => ({ where: `stderr[${i}]`, text: outputText(o) })),
		],
		errors: [
			...(result?.errors ?? []).map((e, i) => ({ where: `errors[${i}]`, text: errorText(e) })),
			{ where: 'error', text: errorText(result?.error) },
			...flatSteps(result?.steps).filter(s => s.error).map((s, i) => ({ where: `step error ${i}`, text: errorText(s.error) })),
		],
		steps: flatSteps(result?.steps).map((s, i) => ({ where: `step title ${i}`, text: s.title })),
		attachments: attachments.filter(a => a.name !== 'trace').flatMap(a => textViews(`attachment ${a.name}`, attachmentContent(a))),
		reports: [
			...(existsSync(join(run.out, 'junit.xml')) ? [{ where: 'junit.xml', text: readFileSync(join(run.out, 'junit.xml'), 'utf8') }] : []),
			...htmlReportViews(join(run.out, 'html')),
		],
	};
};

// Every file the run wrote (the reports, the output dir with the originals of attached files, the stack logs, the
// console log), zips opened. Not html/trace/: that is Playwright's trace viewer app, copied verbatim into every HTML
// report (its code has `cookie=x.value`); the report's data is html/data/ and the zip inside index.html, both scanned.
export const fileViews = (run: SelftestRun): View[] => filesUnder(run.out)
	.filter(f => !f.startsWith(join(run.out, 'html', 'trace')))
	.flatMap(f => textViews(f, readFileSync(f)));

export const leaksIn = (views: View[], secrets: KnownSecret[], forbidden: RegExp[] = []): Leak[] => views.flatMap(v => findLeaks(v.where, v.text, { secrets, forbidden }));
