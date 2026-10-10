// M1-AC18 inner self-test (docs/test-plans/M1-S6.md): when the first test body starts, every service of the stack is
// `healthy` by its compose healthcheck. Records what it saw in $NST_SELFTEST_OUT/health.json for the outer test
// (tests/contract/m1-s6/ac18-stack.test.ts); in the NEG run (web healthcheck on a closed port) this body must never run.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
	writeFileSync(join(out, 'health.json'), JSON.stringify({ project: stack.project, run: stack.run, containers: services, seen }, null, 2));
	for (const [service, info] of Object.entries(seen)) {
		expect(info, `${service} has a container`).not.toBeNull();
		expect(info?.health, `${service} health when the test started`).toBe('healthy');
	}
});
