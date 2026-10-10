// M1-S6a C4 (review M1-S6-r1 C4): the contract run's start-up sweep (tests/contract/support/globalSetup.ts →
// removeLabelled()) removes leftovers of killed runs, but never a compose test stack that is still in use: a developer's
// `node tests/stack/cli.ts up` stack (its descriptor marks it persistent) or a stack whose owning process is alive.
// Real podman resources (a network, a volume and a created container per case) with the harness labels, and real
// descriptors in the harness's descriptor dir. docs/test-plans/M1-S6a.md.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { descriptorDir, descriptorPath } from '../../stack/stack.ts';
import { nodeImage, podman, removeLabelled, runLabel, testLabel } from '../support/podman.ts';

type Kind = 'dev' | 'live' | 'dead' | 'orphan' | 'contract';

interface Case {
	kind: Kind;
	run: string;
	project: string;
	names: { container: string; network: string; volume: string };
	descriptor?: Record<string, unknown>;
}

// The pid of a process that has exited (its owner is gone: a killed Playwright run).
const deadPid = (): number => {
	const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
	if (!r.pid) throw new Error('could not spawn a short-lived process');
	return r.pid;
};

const exists = (args: string[]): boolean => podman([...args], { allowFail: true }).code === 0;

const present = (c: Case): Record<string, boolean> => ({
	container: exists(['container', 'exists', c.names.container]),
	network: exists(['network', 'exists', c.names.network]),
	volume: exists(['volume', 'exists', c.names.volume]),
});

describe('M1-S6a C4 the contract start-up sweep keeps stacks in use', () => {
	const id = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
	const make = (kind: Kind): Case => {
		const run = `c4${kind}${id}`;
		const project = `nst-c4-${kind}-${id}`;
		return { kind, run, project, names: { container: `${project}-c`, network: `${project}-net`, volume: `${project}-vol` } };
	};
	const cases: Record<Kind, Case> = { dev: make('dev'), live: make('live'), dead: make('dead'), orphan: make('orphan'), contract: make('contract') };
	cases.dev.descriptor = { project: cases.dev.project, run: cases.dev.run, owned: true, persistent: true, ownerPid: deadPid() };
	cases.live.descriptor = { project: cases.live.project, run: cases.live.run, owned: true, ownerPid: process.pid };
	cases.dead.descriptor = { project: cases.dead.project, run: cases.dead.run, owned: true, ownerPid: deadPid() };

	beforeAll(() => {
		mkdirSync(descriptorDir(), { recursive: true, mode: 0o700 });
		for (const c of Object.values(cases)) {
			const labels = ['--label', `${testLabel}=${c.kind === 'contract' ? 'contract' : 'stack'}`, '--label', `${runLabel}=${c.run}`];
			podman(['network', 'create', ...labels, c.names.network]);
			podman(['volume', 'create', ...labels, c.names.volume]);
			podman(['create', '--name', c.names.container, ...labels, '--network', c.names.network, '-v', `${c.names.volume}:/data`, nodeImage, 'true']);
			if (c.descriptor) writeFileSync(descriptorPath(c.project), JSON.stringify(c.descriptor), { mode: 0o600 });
		}
		for (const c of Object.values(cases)) expect({ kind: c.kind, ...present(c) }).toEqual({ kind: c.kind, container: true, network: true, volume: true });
		// What the contract globalSetup does before anything else.
		removeLabelled();
	});

	afterAll(() => {
		for (const c of Object.values(cases)) {
			removeLabelled(c.run);
			rmSync(descriptorPath(c.project), { force: true });
		}
	});

	test('c4-keep-dev a persistent `cli.ts up` stack and its descriptor survive the sweep', () => {
		expect(present(cases.dev)).toEqual({ container: true, network: true, volume: true });
		expect(existsSync(descriptorPath(cases.dev.project))).toBe(true);
	});

	test('c4-keep-live a stack whose owning process is alive survives the sweep', () => {
		expect(present(cases.live)).toEqual({ container: true, network: true, volume: true });
		expect(existsSync(descriptorPath(cases.live.project))).toBe(true);
	});

	test('c4-sweep-dead a stack whose owner died is removed, and so is its descriptor', () => {
		expect(present(cases.dead)).toEqual({ container: false, network: false, volume: false });
		expect(existsSync(descriptorPath(cases.dead.project))).toBe(false);
	});

	test('c4-sweep-orphan a stack without a descriptor is removed', () => {
		expect(present(cases.orphan)).toEqual({ container: false, network: false, volume: false });
	});

	test('c4-sweep-contract every contract-labelled leftover is removed', () => {
		expect(present(cases.contract)).toEqual({ container: false, network: false, volume: false });
	});
});
