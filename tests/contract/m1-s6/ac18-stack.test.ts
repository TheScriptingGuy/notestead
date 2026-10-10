// M1-AC18: the harness starts the compose test stack on the Pi with podman and tears it down without leaving
// containers, pods, networks or volumes behind; every service has a compose healthcheck and is `healthy` before any
// test starts. NEG: a `web` healthcheck on a closed port stays unhealthy and the harness aborts, naming `web`, before
// any test runs. Both run the real harness path: Playwright's globalSetup with the stack (docs/test-plans/M1-S6.md).
import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { snapshot } from '../../stack/stack.ts';
import type { PodmanSnapshot } from '../../stack/stack.ts';
import { repoRoot } from '../support/podman.ts';
import { allSpecs, describeRun, runSelftest, stackImagesEnv } from '../support/selftest.ts';

const minute = 60_000;

const diff = (before: PodmanSnapshot, after: PodmanSnapshot): string[] => {
	const out: string[] = [];
	for (const key of ['containers', 'networks', 'volumes', 'pods'] as const) {
		const added = after[key].filter(n => !before[key].includes(n));
		const removed = before[key].filter(n => !after[key].includes(n));
		if (added.length > 0) out.push(`${key} left behind: ${added.join(', ')}`);
		if (removed.length > 0) out.push(`${key} removed that the harness did not create: ${removed.join(', ')}`);
	}
	return out;
};

describe('M1-AC18 compose test stack: up, healthy, down clean', () => {
	test('ac18-compose-static every service of the test stack has a compose healthcheck; headless runs with init, no pod, web publishes only :8080', () => {
		const core = parse(readFileSync(join(repoRoot, 'tests', 'stack', 'compose.yaml'), 'utf8')) as { 'x-podman'?: { in_pod?: boolean }; services: Record<string, { healthcheck?: { test?: unknown }; ports?: string[]; init?: boolean }> };
		const hl = parse(readFileSync(join(repoRoot, 'tests', 'stack', 'compose.headless.yaml'), 'utf8')) as typeof core;
		const services = { ...core.services, ...hl.services };
		expect(Object.keys(services).sort()).toEqual(['headless', 'server', 'web']);
		for (const [name, service] of Object.entries(services)) {
			expect({ name, test: typeof service.healthcheck?.test }).toEqual({ name, test: 'string' });
		}
		expect(hl.services.headless.init).toBe(true);
		expect(core['x-podman']?.in_pod).toBe(false);
		expect(hl['x-podman']?.in_pod).toBe(false);
		expect(core.services.web.ports).toEqual(['127.0.0.1::8080']);
		expect(hl.services.headless.ports).toBeUndefined();
	});

	test('ac18 the stack is healthy when the first test body starts, and nothing is left after the run', () => {
		const images = stackImagesEnv();
		const before = snapshot();
		const run = runSelftest('ac18-up', 'selftest/health.spec.ts', images);
		const after = snapshot();
		expect({ leftovers: diff(before, after) }).toEqual({ leftovers: [] });
		expect({ code: run.code, why: run.code === 0 ? '' : describeRun(run) }).toEqual({ code: 0, why: '' });
		const seen = JSON.parse(readFileSync(join(run.out, 'health.json'), 'utf8')) as { seen: Record<string, { health: string; check: string[]; init: boolean; networkMode: string; pod: string } | null> };
		for (const service of ['server', 'web', 'headless']) {
			const info = seen.seen[service];
			expect({ service, health: info?.health }).toEqual({ service, health: 'healthy' });
			// The check comes from the compose file (the images carry no HEALTHCHECK, ADR-0006 amendment).
			expect({ service, check: info?.check.join(' ') ?? '' }).toEqual({ service, check: expect.stringMatching(/^CMD-SHELL /) });
			expect({ service, pod: info?.pod }).toEqual({ service, pod: '' });
		}
		expect(seen.seen.headless?.init).toBe(true);
		const spec = allSpecs(run.report?.suites ?? []);
		expect(spec.map(s => s.tests[0]?.results[0]?.status)).toEqual(['passed']);
	}, 40 * minute);

	test('ac18-neg a web healthcheck on a closed port: the run aborts naming `web` before any test body runs, nothing left', () => {
		const images = stackImagesEnv();
		const before = snapshot();
		const run = runSelftest('ac18-neg', 'selftest/health.spec.ts', { ...images, NOTESTEAD_STACK_OVERRIDES: 'compose.neg-web-health.yaml' });
		const after = snapshot();
		expect({ leftovers: diff(before, after) }).toEqual({ leftovers: [] });
		expect(run.code).not.toBe(0);
		expect(existsSync(join(run.out, 'body-ran'))).toBe(false);
		const messages = [run.output, ...(run.report?.errors ?? []).map(e => e.message ?? '')].join('\n');
		expect(messages).toMatch(/aborting before any test runs/);
		expect(messages).toMatch(/stack service "web" \(container [^)]+\) is unhealthy/);
		expect(messages).toMatch(/8079/);
		// Positive control inside the same run: the server did come up (the abort is about web, not a broken stack).
		expect(messages).not.toMatch(/stack service "server"/);
	}, 30 * minute);
});
