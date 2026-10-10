// Unit tests of the stack descriptors' liveness rules (tests/stack/descriptors.ts; docs/test-plans/M1-S6a.md, C4 layer
// "unit"), which decide what the contract start-up sweep keeps, and of newStack() recording its owner and, for
// `cli.ts up`, persistence. The C4 contract test proves the sweep on real podman resources.
import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { descriptorDir, descriptorPath, stackDescriptors } from '../../stack/descriptors.ts';
import { newStack } from '../../stack/stack.ts';

describe('stack descriptors', () => {
	const id = randomBytes(4).toString('hex');
	const projects: string[] = [];
	const write = (name: string, body: string): string => {
		const project = `nst-unit-${name}-${id}`;
		projects.push(project);
		mkdirSync(descriptorDir(), { recursive: true, mode: 0o700 });
		writeFileSync(descriptorPath(project), body, { mode: 0o600 });
		return project;
	};
	const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid ?? 0;

	afterAll(() => {
		for (const p of projects) rmSync(descriptorPath(p), { force: true });
	});

	test('persistent, live-owner and legacy (no ownerPid) descriptors are live; a dead owner is not; garbage is ignored', () => {
		const cases = {
			persistent: write('persistent', JSON.stringify({ project: 'x', run: `persistent${id}`, persistent: true, ownerPid: deadPid() })),
			live: write('live', JSON.stringify({ project: 'x', run: `live${id}`, ownerPid: process.pid })),
			legacy: write('legacy', JSON.stringify({ project: 'x', run: `legacy${id}` })),
			dead: write('dead', JSON.stringify({ project: 'x', run: `dead${id}`, ownerPid: deadPid() })),
			garbage: write('garbage', '{"run": '),
		};
		const mine = stackDescriptors().filter(d => Object.values(cases).some(p => d.file === descriptorPath(p)));
		expect(Object.fromEntries(mine.map(d => [d.run.replace(id, ''), d.live]))).toEqual({ persistent: true, live: true, legacy: true, dead: false });
	});

	test('newStack records its owner, and marks a `cli.ts up` stack persistent', () => {
		const saved = process.env.JOPLIN_SERVER_URL;
		delete process.env.JOPLIN_SERVER_URL;
		const images = { server: 's', web: 'w', headless: 'h', device: 'd', built: [] };
		const plain = newStack({ name: 'unit', images, logsDir: '/nonexistent' });
		const dev = newStack({ name: 'unit', images, logsDir: '/nonexistent', persistent: true });
		try {
			expect({ owner: plain.ownerPid, persistent: plain.persistent }).toEqual({ owner: process.pid, persistent: undefined });
			expect({ owner: dev.ownerPid, persistent: dev.persistent }).toEqual({ owner: process.pid, persistent: true });
		} finally {
			rmSync(plain.workDir, { recursive: true, force: true });
			rmSync(dev.workDir, { recursive: true, force: true });
			if (saved !== undefined) process.env.JOPLIN_SERVER_URL = saved;
		}
	});
});
