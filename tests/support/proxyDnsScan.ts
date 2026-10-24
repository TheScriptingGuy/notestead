// The DNS-1 CI scan (docs/test-plans/DNS-1.md DNS1-AC5), as pure functions over log text:
// - Caddy JSON lines of the `web` container: `lookup <name> … i/o timeout` errors, bucketed by their `duration`.
//   The old signature is Caddy's 3 s default dial_timeout expiring inside Go's resolver (2.5 to 4.5 s). Every other
//   duration is listed, never merged into the old bucket (decision rule of DNS1-C5).
// - `lookup <name> on <ip>:53: no such host` (NXDOMAIN) lines are what the tests that stop `server` on purpose cause;
//   they are reported, never counted as failures.
// - Device logs: a seed sync that reports `Last error:`.
export const oldSignatureMinS = 2.5;
export const oldSignatureMaxS = 4.5;

export interface WebScan {
	// `lookup … i/o timeout` with a duration from 2.5 to 4.5 s
	oldSignature: number;
	// every other `lookup … i/o timeout`, with its duration in seconds (null when the line has none)
	otherDurations: (number | null)[];
	// `lookup … no such host`, reported only
	nxdomain: number;
}

const lookupTimeout = /\blookup [^\s:"]+[^"]*i\/o timeout/;
const lookupNxdomain = /\blookup [^\s:"]+ on [^\s:"]+:\d+: no such host/;

export const emptyWebScan = (): WebScan => ({ oldSignature: 0, otherDurations: [], nxdomain: 0 });

export const addWebScans = (a: WebScan, b: WebScan): WebScan => ({
	oldSignature: a.oldSignature + b.oldSignature,
	otherDurations: [...a.otherDurations, ...b.otherDurations],
	nxdomain: a.nxdomain + b.nxdomain,
});

// `seen`: lines already counted (a Set shared across the logs of one runner). A report attachment (`web.log`) holds a
// slice of the stack's `*_web_1.log`, so the two files differ but their lines are the same events; a Caddy line carries
// its timestamp and err_id, so an identical line is the same event. Each is counted once.
export const scanWebLog = (text: string, seen?: Set<string>): WebScan => {
	const scan = emptyWebScan();
	for (const line of text.split('\n')) {
		if (!line.startsWith('{')) continue;
		if (seen) {
			if (seen.has(line)) continue;
			seen.add(line);
		}
		let entry: { msg?: unknown; duration?: unknown };
		try {
			entry = JSON.parse(line) as { msg?: unknown; duration?: unknown };
		} catch {
			continue;
		}
		if (typeof entry.msg !== 'string') continue;
		if (lookupNxdomain.test(entry.msg)) {
			scan.nxdomain++;
		} else if (lookupTimeout.test(entry.msg)) {
			const duration = typeof entry.duration === 'number' ? entry.duration : null;
			if (duration !== null && duration >= oldSignatureMinS && duration <= oldSignatureMaxS) scan.oldSignature++;
			else scan.otherDurations.push(duration);
		}
	}
	return scan;
};

// True when a device log shows a seed sync that failed (`Completed: … Last error: …`).
export const deviceHasLastError = (text: string): boolean => text.split('\n').some(line => line.includes('Last error:'));

// The runner of a path: the `<runner>` of its `test-results-e2e-<runner>` folder, or 'unknown'.
export const runnerOf = (path: string): string => /(?:^|\/)test-results-e2e-([^/]+)(?:\/|$)/.exec(path)?.[1] ?? 'unknown';

export type LogKind = 'web' | 'device' | undefined;

// Which logs the scan reads: a stack's `*_web_1.log`, any `web*.log` (attachments) and every `device-*.log`.
export const logKindOf = (path: string): LogKind => {
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (/_web_1\.log$/.test(name) || /^web.*\.log$/.test(name)) return 'web';
	if (/^device-.*\.log$/.test(name)) return 'device';
	return undefined;
};
