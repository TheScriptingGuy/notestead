// M1-AC20: a deliberately failing self-test attaches the server log, the supervisor log, the browser console and the
// Playwright trace (and the web log) to the report; no attachment holds an unredacted token= or credential header
// value; the 502 path's error entry is in the attached web log without any of its marker values.
// The inner test is tests/harness/selftest/attachments.spec.ts. docs/test-plans/M1-S6.md.
import { beforeAll, describe, expect, test } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findLeaks, textViews } from '../../support/redact.ts';
import type { KnownSecret, Leak } from '../../support/redact.ts';
import { snapshot } from '../../stack/stack.ts';
import { allSpecs, describeRun, runSelftest, stackImagesEnv } from '../support/selftest.ts';
import type { PwAttachment, PwResult, SelftestRun } from '../support/selftest.ts';

const minute = 60_000;

interface Planted {
	inPageVisible: string;
	markers: Record<string, string>;
	secrets: KnownSecret[];
}

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap(name => {
	const path = join(dir, name);
	return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

describe('M1-AC20 log attachments of a failing test', () => {
	let run: SelftestRun | undefined;
	let result: PwResult | undefined;
	let planted: Planted | undefined;
	let leftovers: string[] = [];

	beforeAll(() => {
		const images = stackImagesEnv();
		const before = snapshot();
		run = runSelftest('ac20', 'selftest/attachments.spec.ts', images);
		const after = snapshot();
		leftovers = (['containers', 'networks', 'volumes', 'pods'] as const).flatMap(k => after[k].filter(n => !before[k].includes(n)).map(n => `${k}: ${n}`));
		result = allSpecs(run.report?.suites ?? [])[0]?.tests[0]?.results[0];
		const file = join(run.out, 'planted.json');
		if (existsSync(file)) planted = JSON.parse(readFileSync(file, 'utf8')) as Planted;
	}, 40 * minute);

	const attachment = (pattern: RegExp): PwAttachment => {
		const found = result?.attachments.find(a => pattern.test(a.name));
		if (!found) throw new Error(`no attachment named ${pattern} (have: ${result?.attachments.map(a => a.name).join(', ') ?? 'no result'}); ${run ? describeRun(run) : ''}`);
		return found;
	};

	const content = (a: PwAttachment): Buffer => {
		if (a.path) return readFileSync(a.path);
		return Buffer.from(a.body ?? '', 'base64');
	};

	const text = (pattern: RegExp): string => textViews('x', content(attachment(pattern))).map(v => v.text).join('\n');

	test('ac20-ran the inner test failed on purpose (and only on purpose), leaving nothing behind', () => {
		expect(run?.code).not.toBe(0);
		expect(result?.status).toBe('failed');
		expect(result?.errors.map(e => e.message ?? '').join('\n')).toContain('M1-AC20: this failure is deliberate');
		expect(planted).toBeDefined();
		expect(leftovers).toEqual([]);
	});

	test('ac20-attached server log, web log, supervisor log, browser console and trace are attached', () => {
		for (const pattern of [/^server\.log$/, /^web\.log$/, /^supervisor\.log$/, /^browser-console\.log$/, /^trace$/]) {
			const a = attachment(pattern);
			expect({ name: a.name, size: content(a).length > 0 }).toEqual({ name: a.name, size: true });
		}
	});

	test('ac20-content each attachment holds the failing test\'s own events (positive controls)', () => {
		const visible = planted?.inPageVisible ?? 'missing';
		// The in-page request reached the server (it logs the path) and went through web (access log).
		expect(text(/^server\.log$/)).toContain(visible);
		expect(text(/^web\.log$/)).toContain(visible);
		expect(text(/^browser-console\.log$/)).toContain(`response 403 for ${visible}`);
		// The trace holds the page's request and its console messages.
		const trace = textViews('trace', content(attachment(/^trace$/)));
		expect(trace.some(v => /\.network$/.test(v.where) && v.text.includes(visible))).toBe(true);
		expect(trace.some(v => /\.trace$/.test(v.where) && v.text.includes(`response 403 for ${visible}`))).toBe(true);
		// The supervisor log is the headless service's own log (it reached ready).
		expect(text(/^supervisor\.log$/)).toMatch(/\S/);
		expect(text(/^supervisor\.log$/)).toMatch(/ready|healthz|sync/i);
	});

	test('ac20-502 the web log holds the 502 request\'s error entry (path marker) and none of its marker values', () => {
		const markers = planted?.markers ?? {};
		const lines = text(/^web\.log$/).split('\n').filter(l => l.includes(markers.path ?? 'missing'));
		const errorEntries = lines.filter(l => {
			try {
				const entry = JSON.parse(l) as { level?: string; logger?: string };
				return entry.level === 'error';
			} catch {
				return false;
			}
		});
		expect({ errorEntries: errorEntries.length > 0, lines: lines.length }).toEqual({ errorEntries: true, lines: lines.length });
		for (const [name, value] of Object.entries(markers)) {
			if (name === 'path') continue;
			expect({ name, inWebLog: text(/^web\.log$/).includes(value) }).toEqual({ name, inWebLog: false });
		}
	});

	test('ac20-redacted no artifact of the run holds an unredacted token=, credential header, planted secret or real secret', () => {
		const secrets: KnownSecret[] = [
			...(planted?.secrets ?? []).filter(s => s.value !== ''),
			...Object.entries(planted?.markers ?? {}).filter(([k]) => k !== 'path').map(([label, value]) => ({ label, value })),
		];
		expect(secrets.length).toBeGreaterThanOrEqual(8);
		const leaks: Leak[] = [];
		const seen = new Set<string>();
		// Every attachment of the report, and every file the run wrote (output dir, stack logs, console log), except the
		// self-test's own planted.json.
		const sources: { where: string; data: Buffer }[] = [
			...(result?.attachments ?? []).map(a => ({ where: `attachment ${a.name}`, data: content(a) })),
			...filesUnder(run?.out ?? '.').filter(f => !f.endsWith('planted.json')).map(f => ({ where: f, data: readFileSync(f) })),
		];
		for (const source of sources) {
			for (const view of textViews(source.where, source.data)) {
				if (seen.has(view.where)) continue;
				seen.add(view.where);
				leaks.push(...findLeaks(view.where, view.text, { secrets, forbidden: [/nstsecret[0-9a-f]{24}/] }));
			}
		}
		expect(seen.size).toBeGreaterThan(5);
		expect(leaks).toEqual([]);
	});
});
