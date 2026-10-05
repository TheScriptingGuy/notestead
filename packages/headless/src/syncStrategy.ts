// The SyncStrategy seam (ADR-0003 Decision 2): how the CLI is synced, decrypted and served is isolated behind this
// interface, so a future strategy (for example an upstream daemon mode) replaces it without touching the rest.
// M1-S5 delivers the minimal subset: start (initial sync + decrypt, then the Data API), status and stop. M3 adds
// requestSync (the cycle loop and its triggers) and withApi (queueing during cycles), as ADR-0003 specifies.
export type SyncState = 'starting' | 'ready' | 'stopping';

export interface SyncStatus {
	state: SyncState;
	// ISO-8601 UTC time of the last successful sync (Date#toISOString), once there has been one.
	lastSync?: string;
}

export interface SyncStrategy {
	// Brings the Data API up, after a successful initial sync and decryption. Resolves once ready; retries failed
	// attempts until it succeeds or stop() is called.
	start(): Promise<void>;
	status(): SyncStatus;
	stop(): Promise<void>;
}
