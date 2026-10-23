// When a restarted headless service counts as ready (docs/test-plans/CI-M2-S2-x64-arm64.md, finding F). Ready is the
// supervisor's own /healthz: 200 with a lastSync strictly after the restart. Podman's health status is not part of it: on the
// CI runners it stayed "starting" for minutes after `podman restart` although /healthz was ready (its health timer was lost),
// so it is used only to fail fast. No Playwright import; shared by Jest and Playwright like tests/stack/*.
export interface RestartObservation {
	running: boolean;
	// podman's health status: healthy, starting, unhealthy, exited, ...
	health: string;
	// the supervisor's /healthz, undefined when the exec failed or printed nothing
	healthz?: { status: number; lastSync?: string };
	// the time of the restart, epoch ms
	startedMs: number;
}

export const restartVerdict = (o: RestartObservation): 'done' | 'wait' | { fail: string } => {
	const ready = o.healthz?.status === 200 && o.healthz.lastSync !== undefined && Date.parse(o.healthz.lastSync) > o.startedMs;
	if (ready) return 'done';
	if (!o.running || o.health === 'exited') return { fail: 'the headless container exited after the restart' };
	if (o.health === 'unhealthy') return { fail: 'the headless container is unhealthy after the restart and /healthz is not ready' };
	return 'wait';
};
