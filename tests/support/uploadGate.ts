// The upload gate (M1-S8 C1-R2, review M1-S6a-r1 C1-R2 and M1-S7-r1; docs/test-plans/M1-S8.md §C1-R2). CI runs it
// (`node tests/harness/upload-gate.ts`, if: always()) after the test steps and uploads test-results/ and
// playwright-report/ only when it succeeded. It makes the result trees safe to publish even when a run was killed
// before the redacting reporter finished. Shared by Jest (CommonJS) and Node (ESM): no __dirname, no import.meta.
// RED stub: the behaviour is specified by tests/unit/harness/uploadGate.test.ts and
// tests/integration/harness/c1r2-killed-run.test.ts.

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

export const runUploadGate = (_opts: UploadGateOptions): UploadGateSummary => {
	throw new Error('C1-R2 upload gate: not implemented yet (docs/test-plans/M1-S8.md §C1-R2)');
};
