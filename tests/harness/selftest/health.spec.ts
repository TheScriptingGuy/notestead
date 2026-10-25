// M1-AC18 inner self-test (docs/test-plans/M1-S6.md): when the first test body starts, every service of the stack is
// `healthy` by its compose healthcheck. Records what it saw in $NST_SELFTEST_OUT/health.json for the outer test
// (tests/contract/m1-s6/ac18-stack.test.ts); in the NEG run (web healthcheck on a closed port) this body must never run.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfTestHealthy } from '../../stack/restartReady.ts';
import { headlessHealthz } from '../../stack/stack.ts';
import { expect, test } from '../../e2e/support/fixtures.ts';

const inspect = (container: string): { health: string; check: string[]; init: boolean; networkMode: string; pod: string } => {
	const r = spawnSync('podman', ['inspect', '--format', '{{json .State.Health.Status}}\t{{json .Config.Healthcheck.Test}}\t{{json .HostConfig.Init}}\t{{json .HostConfig.NetworkMode}}\t{{json .Pod}}', container], { encoding: 'utf8' });
	const [health, check, init, networkMode, pod] = r.stdout.trim().split('\t').map(v => JSON.parse(v || 'null') as unknown);
	return { health: String(health), check: (check as string[] | null) ?? [], init: init === true, networkMode: String(networkMode), pod: String(pod ?? '') };
};

test('stack services are healthy when the first test starts', async ({ stack }) => {
	const out = process.env.NST_SELFTEST_OUT ?? '';
	writeFileSync(join(out, 'body-ran'), new Date().toISOString());
	const services: Record<string, string | undefined> = {
		server: stack.containers.server,
		web: stack.containers.web,
		headless: stack.defaultHeadless?.container,
	};
	const seen: Record<string, ReturnType<typeof inspect> | null> = {};
	for (const [service, container] of Object.entries(services)) seen[service] = container ? inspect(container) : null;
	// The headless service is judged by its supervisor's /healthz, as its readiness is (CI-M2-S2 H): podman's status can lag.
	const headlessContainer = services.headless;
	const healthz = headlessContainer ? headlessHealthz(headlessContainer) : undefined;
	writeFileSync(join(out, 'health.json'), JSON.stringify({ project: stack.project, run: stack.run, containers: services, seen, healthz: { headless: healthz ?? null } }, null, 2));
	for (const [service, info] of Object.entries(seen)) {
		expect(info, `${service} has a container`).not.toBeNull();
		const name = service as 'server' | 'web' | 'headless';
		const observed = name === 'headless'
			? `podman health ${info?.health}, /healthz ${healthz ? `${healthz.status} ${healthz.state ?? ''}`.trim() : 'no answer'}`
			: `podman health ${info?.health}`;
		const rule = name === 'headless' ? 'headless is healthy when its /healthz is 200' : `${name} is healthy when podman health is healthy`;
		expect(selfTestHealthy(name, { podmanHealth: info?.health ?? '', healthz }), `${rule}; observed: ${observed}`).toBe(true);
	}
});
