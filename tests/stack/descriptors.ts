// Stack descriptors (docs/test-plans/M1-S6.md §Compose test stack; M1-S6a C4): the JSON state of every compose test
// stack that is up, one file per project, so that `JOPLIN_SERVER_URL` can attach to it (reuse mode) and
// `cli.ts down <project>` can remove it. The contract sweep (tests/contract/support/podman.ts removeLabelled) keeps the
// stacks whose descriptor is live:
// - persistent: started by `node tests/stack/cli.ts up` (a developer's stack; it outlives the process that made it);
// - or its ownerPid is alive (a Playwright run in progress);
// - or it has no ownerPid (written before M1-S6a: it may be a developer's stack; `cli.ts down` removes it).
// No heavy imports: shared by stack.ts and the contract podman helpers without an import cycle.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const descriptorDir = (): string => join(tmpdir(), 'notestead-stacks');
export const descriptorPath = (project: string): string => join(descriptorDir(), `${project}.json`);

export interface DescriptorInfo {
	file: string;
	project: string;
	run: string;
	live: boolean;
}

export const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
};

export const stackDescriptors = (): DescriptorInfo[] => {
	const dir = descriptorDir();
	if (!existsSync(dir)) return [];
	const out: DescriptorInfo[] = [];
	for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
		const file = join(dir, name);
		try {
			const d = JSON.parse(readFileSync(file, 'utf8')) as { project?: unknown; run?: unknown; persistent?: unknown; ownerPid?: unknown };
			if (typeof d.run !== 'string' || typeof d.project !== 'string') continue;
			const live = d.persistent === true || typeof d.ownerPid !== 'number' || pidAlive(d.ownerPid);
			out.push({ file, project: d.project, run: d.run, live });
		} catch {
			// not a descriptor (or one being written): never acted upon
		}
	}
	return out;
};

export const removeDescriptor = (info: DescriptorInfo): void => {
	rmSync(info.file, { force: true });
};
