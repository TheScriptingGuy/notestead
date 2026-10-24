// The CI evidence for DNS1-AC5 (docs/test-plans/DNS-1.md): scans the downloaded e2e artifacts for the proxy's
// `lookup server … i/o timeout` signature and for device logs with `Last error`, per runner.
//   node tests/harness/tools/scan-proxy-dns.ts <dir>...
// Walks each directory. The runner comes from the `test-results-e2e-<runner>` folder name. The web logs read are the
// stacks' `*_web_1.log` and any `web*.log` (attachments); the device logs are `device-*.log`. A file whose content hash
// was already seen for that runner is skipped (a duplicated copy counts once), and a web log line already counted for
// that runner is skipped (a `web.log` attachment holds a slice of its stack's `*_web_1.log`: same events, different
// file). Prints one JSON summary.
// Redacted logs only: the tool prints counts, durations and paths, never log content.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addWebScans, deviceHasLastError, emptyWebScan, logKindOf, runnerOf, scanWebLog } from '../../support/proxyDnsScan.ts';
import type { WebScan } from '../../support/proxyDnsScan.ts';

interface RunnerSummary {
	webLogs: number;
	deviceLogs: number;
	duplicatesSkipped: number;
	oldSignature: number;
	otherDurationLines: number;
	otherDurations: (number | null)[];
	nxdomainLines: number;
	devicesWithLastError: string[];
}

const files = function* (dir: string): Generator<string> {
	for (const entry of readdirSync(dir).sort()) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) yield* files(path);
		else if (stat.isFile()) yield path;
	}
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
	process.stderr.write('usage: node tests/harness/tools/scan-proxy-dns.ts <dir>...\n');
	process.exit(2);
}

const seen = new Map<string, Set<string>>();
const seenLines = new Map<string, Set<string>>();
const webTotals = new Map<string, WebScan>();
const summaries = new Map<string, RunnerSummary>();
const summaryOf = (runner: string): RunnerSummary => {
	let s = summaries.get(runner);
	if (!s) {
		s = { webLogs: 0, deviceLogs: 0, duplicatesSkipped: 0, oldSignature: 0, otherDurationLines: 0, otherDurations: [], nxdomainLines: 0, devicesWithLastError: [] };
		summaries.set(runner, s);
		seen.set(runner, new Set());
		seenLines.set(runner, new Set());
		webTotals.set(runner, emptyWebScan());
	}
	return s;
};

for (const dir of dirs) {
	for (const path of files(dir)) {
		const kind = logKindOf(path);
		if (!kind) continue;
		const runner = runnerOf(path);
		const summary = summaryOf(runner);
		const content = readFileSync(path);
		const hash = createHash('sha256').update(content).digest('hex');
		const hashes = seen.get(runner) as Set<string>;
		if (hashes.has(`${kind}:${hash}`)) {
			summary.duplicatesSkipped++;
			continue;
		}
		hashes.add(`${kind}:${hash}`);
		const text = content.toString('utf8');
		if (kind === 'web') {
			summary.webLogs++;
			webTotals.set(runner, addWebScans(webTotals.get(runner) as WebScan, scanWebLog(text, seenLines.get(runner))));
		} else {
			summary.deviceLogs++;
			if (deviceHasLastError(text)) summary.devicesWithLastError.push(path);
		}
	}
}

const result: Record<string, RunnerSummary> = {};
for (const [runner, summary] of [...summaries].sort(([a], [b]) => a.localeCompare(b))) {
	const web = webTotals.get(runner) as WebScan;
	result[runner] = { ...summary, oldSignature: web.oldSignature, otherDurationLines: web.otherDurations.length, otherDurations: web.otherDurations, nxdomainLines: web.nxdomain };
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
