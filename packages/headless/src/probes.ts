// HTTP readiness probes on public interfaces only:
// - the sync target's `GET <JOPLIN_SERVER_URL>/api/ping` (Joplin Server API: `{"status":"ok",…}`);
// - the CLI Data API's `GET /ping` on 127.0.0.1 (REST Data API: the text `JoplinClipperServer`).
// Waiting is always for a condition (a successful probe), with a deadline; never a fixed sleep.
import { setTimeout as delay } from 'node:timers/promises';

export interface ProbeResult {
	ok: boolean;
	// What was seen, for the log: "ok", "HTTP 502", "ECONNREFUSED", … Never a URL with a query or a secret.
	detail: string;
}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; text: () => Promise<string> }>;

const describeError = (error: unknown): string => {
	const e = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
	if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
	return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(error);
};

export const pingSyncTarget = async (serverUrl: string, fetchImpl: FetchLike = fetch, timeoutMs = 15_000): Promise<ProbeResult> => {
	try {
		const res = await fetchImpl(`${serverUrl}/api/ping`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
		const text = await res.text();
		if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}` };
		let status: unknown;
		try {
			status = (JSON.parse(text) as { status?: unknown }).status;
		} catch {
			return { ok: false, detail: 'not a Joplin Server ping response' };
		}
		return status === 'ok' ? { ok: true, detail: 'ok' } : { ok: false, detail: `status ${JSON.stringify(status)}` };
	} catch (error) {
		return { ok: false, detail: describeError(error) };
	}
};

export const dataApiPingText = 'JoplinClipperServer';

export const pingDataApi = async (port: number, fetchImpl: FetchLike = fetch, timeoutMs = 5_000): Promise<ProbeResult> => {
	try {
		const res = await fetchImpl(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
		const text = await res.text();
		if (res.status === 200 && text === dataApiPingText) return { ok: true, detail: 'ok' };
		return { ok: false, detail: `HTTP ${res.status}` };
	} catch (error) {
		return { ok: false, detail: describeError(error) };
	}
};

export interface WaitOptions {
	timeoutMs: number;
	intervalMs?: number;
	// Stops waiting early (for example: the process that should answer has exited).
	abortIf?: () => string | undefined;
}

// Polls `probe` until it succeeds. Rejects with the last detail when the deadline passes or `abortIf` names a reason.
export const waitUntilReady = async (probe: () => Promise<ProbeResult>, options: WaitOptions): Promise<void> => {
	const deadline = Date.now() + options.timeoutMs;
	let last: ProbeResult = { ok: false, detail: 'not probed' };
	for (;;) {
		const reason = options.abortIf?.();
		if (reason) throw new Error(reason);
		last = await probe();
		if (last.ok) return;
		if (Date.now() >= deadline) throw new Error(`not ready after ${options.timeoutMs} ms (last: ${last.detail})`);
		await delay(options.intervalMs ?? 250);
	}
};
