// Unit tests of the stack descriptors' liveness rules (tests/stack/descriptors.ts; docs/test-plans/M1-S6a.md, C4 layer
// "unit"), which decide what the contract start-up sweep keeps, and of newStack() recording its owner and, for
// `cli.ts up`, persistence. The C4 contract test proves the sweep on real podman resources.
// M1-S8 (docs/test-plans/M1-S8.md): C4-R3, newStack() saves the descriptor before anything starts; C5, the descriptors
// (which hold throwaway passwords) live in a per-user 0700 directory that is checked before it is trusted.
import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptorDir, descriptorPath, stackDescriptors } from '../../stack/descriptors.ts';
import { attachStack, newStack, saveDescriptor } from '../../stack/stack.ts';
import type { StackState } from '../../stack/stack.ts';

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
			for (const st of [plain, dev]) {
				rmSync(st.workDir, { recursive: true, force: true });
				rmSync(descriptorPath(st.project), { force: true });
			}
			if (saved !== undefined) process.env.JOPLIN_SERVER_URL = saved;
		}
	});

	test('c4r3 newStack saves its descriptor before anything starts, so a concurrent sweep keeps a stack that is still starting', () => {
		const saved = process.env.JOPLIN_SERVER_URL;
		delete process.env.JOPLIN_SERVER_URL;
		const images = { server: 's', web: 'w', headless: 'h', device: 'd', built: [] };
		const stack = newStack({ name: 'unit', images, logsDir: '/nonexistent' });
		try {
			const file = descriptorPath(stack.project);
			const onDisk = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { ownerPid?: number; run?: string } : undefined;
			const listed = stackDescriptors().find(d => d.file === file);
			expect({ saved: onDisk !== undefined, owner: onDisk?.ownerPid, run: onDisk?.run, live: listed?.live }).toEqual({ saved: true, owner: process.pid, run: stack.run, live: true });
		} finally {
			rmSync(stack.workDir, { recursive: true, force: true });
			rmSync(descriptorPath(stack.project), { force: true });
			if (saved !== undefined) process.env.JOPLIN_SERVER_URL = saved;
		}
	});

	describe('stack descriptors at rest (M1-S8 C5)', () => {
		const uid = process.getuid?.() ?? -1;
		const saved = process.env.NOTESTEAD_STACKS_DIR;
		const temps: string[] = [];
		const freshBase = (): string => {
			const base = mkdtempSync(join(tmpdir(), 'nst-unit-c5-'));
			temps.push(base);
			return base;
		};
		const state = (project: string): StackState => ({ project, run: `run${project}`, owned: true, ownerPid: process.pid, accounts: [{ email: 'a@b', password: 'nstpw-unit-c5-not-real', masterPassword: 'nstmp-unit-c5-not-real' }] } as unknown as StackState);
		const modeOf = (p: string): number => lstatSync(p).mode & 0o777;

		afterAll(() => {
			if (saved === undefined) delete process.env.NOTESTEAD_STACKS_DIR;
			else process.env.NOTESTEAD_STACKS_DIR = saved;
			for (const t of temps) rmSync(t, { recursive: true, force: true });
			// Wherever the implementation under test put them (before C5 it ignored the override).
			for (const p of ['create', 'mode', 'link', 'attach']) rmSync(descriptorPath(`nst-unit-c5-${p}`), { force: true });
		});

		test('c5-dir by default the descriptors live in a per-user directory under the temp dir, not the shared /tmp/notestead-stacks', () => {
			delete process.env.NOTESTEAD_STACKS_DIR;
			expect(descriptorDir()).toBe(join(tmpdir(), `notestead-stacks-${uid}`));
		});

		test('c5-create saving a descriptor creates the directory 0700 and the file 0600 (NOTESTEAD_STACKS_DIR: a test-only override)', () => {
			const dir = join(freshBase(), 'stacks');
			process.env.NOTESTEAD_STACKS_DIR = dir;
			saveDescriptor(state('nst-unit-c5-create'));
			expect({ dir: modeOf(dir), file: modeOf(join(dir, 'nst-unit-c5-create.json')) }).toEqual({ dir: 0o700, file: 0o600 });
		});

		test('c5-dir-mode NEG a descriptor directory that others can read or write is refused (save and list), naming it; nothing is written', () => {
			const dir = join(freshBase(), 'stacks');
			mkdirSync(dir, { mode: 0o700 });
			chmodSync(dir, 0o755);
			process.env.NOTESTEAD_STACKS_DIR = dir;
			expect(() => saveDescriptor(state('nst-unit-c5-mode'))).toThrow(dir);
			expect(() => stackDescriptors()).toThrow(dir);
			expect(existsSync(join(dir, 'nst-unit-c5-mode.json'))).toBe(false);
		});

		test('c5-dir-symlink NEG a descriptor directory that is a symlink is refused', () => {
			const base = freshBase();
			const real = join(base, 'elsewhere');
			mkdirSync(real, { mode: 0o700 });
			const link = join(base, 'stacks');
			symlinkSync(real, link);
			process.env.NOTESTEAD_STACKS_DIR = link;
			expect(() => saveDescriptor(state('nst-unit-c5-link'))).toThrow(link);
			expect(existsSync(join(real, 'nst-unit-c5-link.json'))).toBe(false);
		});

		test('c5-attach NEG attachStack refuses a descriptor file that others can read; the same file at 0600 is trusted (positive control)', () => {
			const dir = join(freshBase(), 'stacks');
			mkdirSync(dir, { mode: 0o700 });
			process.env.NOTESTEAD_STACKS_DIR = dir;
			const project = 'nst-unit-c5-attach';
			const file = join(dir, `${project}.json`);
			writeFileSync(file, JSON.stringify(state(project)), { mode: 0o600 });
			chmodSync(file, 0o644);
			const server = { container: 'c', project, run: `run${project}`, url: 'http://127.0.0.1:1' };
			expect(() => attachStack(server)).toThrow(file);
			chmodSync(file, 0o600);
			expect(attachStack(server)).toMatchObject({ project, owned: false, attached: true });
		});
	});
});
