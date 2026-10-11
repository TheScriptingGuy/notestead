// The upload gate (M1-S8 C1-R2, review M1-S6a-r1 C1-R2 and M1-S7-r1; docs/test-plans/M1-S8.md §C1-R2). CI runs it
// (`node tests/harness/upload-gate.ts`, if: always()) after the test steps and uploads test-results/ and
// playwright-report/ only when it succeeded. It makes the result trees safe to publish even when a run was killed
// before the redacting reporter finished (a job timeout or cancellation ends in SIGKILL):
// 1. leftover secret registries (nst-secrets-*/secrets.jsonl in the temp dir: a killed run never removed its own) are
//    read, for step 4, and then removed;
// 2. every Playwright run under the roots whose `redaction-pending.json` has no `redaction-complete.json` beside it
//    (tests/e2e/support/redactingReporter.ts writes both) loses everything that marker lists: its output dir (traces,
//    attachments) and its HTML, JUnit and JSON reports. Without a usable list, everything in the run's directory except
//    its `stack/` logs (redacted when written) goes;
// 3. every `planted.json` (the self-tests' planted secrets, review M1-S6-r1 C5) and every raw `.playwright-artifacts-*`
//    directory (trace chunks a killed worker left) is removed;
// 4. every remaining, non-hidden file is redacted with the leftover secrets and the token=/credential-header patterns
//    (tests/support/redact.ts; zips entry by entry). A file that cannot be redacted is removed.
// 5. a value-free summary is written (default <first root>/upload-gate.json).
// Hidden files and directories are not redacted: upload-artifact leaves them out by default, and e2e.yml must not turn
// that off (M1-S8-E08). Shared by Jest (CommonJS) and Node (ESM): no __dirname, no import.meta.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { redactBuffer } from './redact.ts';
import type { KnownSecret } from './redact.ts';
import { mergeSecrets, readSecretsFile } from './secrets.ts';

export const pendingMarker = 'redaction-pending.json';
export const completeMarker = 'redaction-complete.json';

export interface UploadGateOptions {
	// the trees to make safe (CI: test-results and playwright-report)
	roots: string[];
	// where leftover secret registries (nst-secrets-*/secrets.jsonl) are looked for (default: the OS temp dir)
	secretsDirs?: string[];
	// the value-free summary (default: <first root>/upload-gate.json)
	summaryFile?: string;
}

export interface GateRun {
	// the directory holding the run's markers, relative to the current directory
	dir: string;
	complete: boolean;
	// what was removed because the run did not finish its redaction (relative paths)
	removed: string[];
}

export interface UploadGateSummary {
	runs: GateRun[];
	plantedRemoved: number;
	artifactDirsRemoved: number;
	filesRedacted: number;
	filesRemoved: number;
	registries: number;
}

const uid = (): number => process.getuid?.() ?? -1;
const rel = (p: string): string => relative(process.cwd(), p) || '.';
const isInside = (base: string, p: string): boolean => {
	const r = relative(base, p);
	return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep));
};

// Every entry under `dir` (files and directories, symlinks not followed), depth first.
const entries = (dir: string): { path: string; isDir: boolean; name: string }[] => {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap(name => {
		const path = join(dir, name);
		let isDir = false;
		try {
			const st = lstatSync(path);
			isDir = st.isDirectory();
		} catch {
			return [];
		}
		return [{ path, isDir, name }, ...(isDir ? entries(path) : [])];
	});
};

const leftoverRegistries = (dirs: string[]): string[] => dirs.flatMap(dir => {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.filter(n => n.startsWith('nst-secrets-')).map(n => join(dir, n)).filter(d => {
		try {
			const st = lstatSync(d);
			return st.isDirectory() && (uid() < 0 || st.uid === uid()) && existsSync(join(d, 'secrets.jsonl'));
		} catch {
			return false;
		}
	});
});

const pendingPaths = (marker: string): string[] | undefined => {
	try {
		const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { paths?: unknown };
		if (!Array.isArray(parsed.paths) || !parsed.paths.every(p => typeof p === 'string')) return undefined;
		return parsed.paths as string[];
	} catch {
		return undefined;
	}
};

export const runUploadGate = (opts: UploadGateOptions): UploadGateSummary => {
	const roots = opts.roots.map(r => resolve(r));
	const present = roots.filter(r => existsSync(r));
	const summary: UploadGateSummary = { runs: [], plantedRemoved: 0, artifactDirsRemoved: 0, filesRedacted: 0, filesRemoved: 0, registries: 0 };

	// 1. Leftover registries.
	const registries = leftoverRegistries(opts.secretsDirs ?? [tmpdir()]);
	const secrets: KnownSecret[] = mergeSecrets(...registries.map(d => readSecretsFile(join(d, 'secrets.jsonl'))));
	summary.registries = registries.length;

	const remove = (p: string): boolean => {
		if (!existsSync(p)) return false;
		rmSync(p, { recursive: true, force: true });
		return true;
	};

	// 2. Runs whose redaction did not complete.
	for (const root of present) {
		for (const e of entries(root).filter(x => !x.isDir && x.name === pendingMarker)) {
			const dir = dirname(e.path);
			const complete = existsSync(join(dir, completeMarker));
			const run: GateRun = { dir: rel(dir), complete, removed: [] };
			if (!complete) {
				const listed = pendingPaths(e.path);
				const targets = listed
					? listed.map(p => resolve(p)).filter(p => roots.some(r => isInside(r, p)))
					: readdirSync(dir).filter(n => n !== 'stack' && n !== pendingMarker).map(n => join(dir, n));
				for (const t of targets) if (remove(t)) run.removed.push(rel(t));
				summary.filesRemoved += run.removed.length;
			}
			summary.runs.push(run);
		}
	}

	// 3. planted.json and raw trace chunks.
	for (const root of present) {
		for (const e of entries(root)) {
			if (!existsSync(e.path)) continue;
			if (!e.isDir && e.name === 'planted.json' && remove(e.path)) summary.plantedRemoved++;
			if (e.isDir && e.name.startsWith('.playwright-artifacts-') && remove(e.path)) summary.artifactDirsRemoved++;
		}
	}

	// 4. Redact everything that is left and would be uploaded (hidden entries are not uploaded).
	for (const root of present) {
		for (const e of entries(root)) {
			if (e.isDir || !existsSync(e.path)) continue;
			if (relative(root, e.path).split(sep).some(part => part.startsWith('.'))) continue;
			try {
				const before = readFileSync(e.path);
				const after = redactBuffer(before, secrets);
				if (!after.equals(before)) {
					writeFileSync(e.path, after);
					summary.filesRedacted++;
				}
			} catch {
				rmSync(e.path, { force: true });
				summary.filesRemoved++;
			}
		}
	}

	// Registries are removed once used: their values have been applied.
	for (const d of registries) rmSync(d, { recursive: true, force: true });

	// 5. The value-free summary.
	const summaryFile = resolve(opts.summaryFile ?? join(roots[0] ?? process.cwd(), 'upload-gate.json'));
	mkdirSync(dirname(summaryFile), { recursive: true });
	writeFileSync(summaryFile, `${JSON.stringify({ ...summary, at: new Date().toISOString(), roots: roots.map(rel) }, null, 2)}\n`);
	return summary;
};
