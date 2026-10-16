// Stack descriptors (docs/test-plans/M1-S6.md §Compose test stack; M1-S6a C4): the JSON state of every compose test
// stack that is up, one file per project, so that `JOPLIN_SERVER_URL` can attach to it (reuse mode) and
// `cli.ts down <project>` can remove it. The contract sweep (tests/contract/support/podman.ts removeLabelled) keeps the
// stacks whose descriptor is live:
// - persistent: started by `node tests/stack/cli.ts up` (a developer's stack; it outlives the process that made it);
// - or its ownerPid is alive (a Playwright run in progress);
// - or it has no ownerPid (written before M1-S6a: it may be a developer's stack; `cli.ts down` removes it).
// No heavy imports: shared by stack.ts and the contract podman helpers without an import cycle.
// At rest (M1-S8 C5, review M1-S6-r1 C5): a descriptor holds the stack's throwaway account passwords. The directory is
// per user (tmpdir()/notestead-stacks-<uid>), created 0700, and checked before every use: it must be a real directory
// (not a symlink) owned by this user with no group or other permissions, and a descriptor file must be a regular
// 0600-style file owned by this user, or it is not trusted. NOTESTEAD_STACKS_DIR overrides the directory (tests only).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const uid = (): number => process.getuid?.() ?? -1;

export const descriptorDir = (): string => process.env.NOTESTEAD_STACKS_DIR || join(tmpdir(), `notestead-stacks-${uid()}`);
export const descriptorPath = (project: string): string => join(descriptorDir(), `${project}.json`);

export class InsecureDescriptorError extends Error {}

const insecurity = (path: string, kind: 'directory' | 'file'): string | undefined => {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) return `${path} is a symlink`;
	if (kind === 'directory' ? !st.isDirectory() : !st.isFile()) return `${path} is not a ${kind}`;
	if (uid() >= 0 && st.uid !== uid()) return `${path} is owned by uid ${st.uid}, not ${uid()}`;
	if ((st.mode & 0o077) !== 0) return `${path} has mode ${(st.mode & 0o777).toString(8)}; group and others must have no access`;
	return undefined;
};

// The descriptor directory, created 0700 if it does not exist; throws if it is not safe to use.
export const ensureDescriptorDir = (create: boolean): string => {
	const dir = descriptorDir();
	if (!existsSync(dir)) {
		if (!create) return dir;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const problem = insecurity(dir, 'directory');
	if (problem) throw new InsecureDescriptorError(`stack descriptor directory ${dir} is not safe to use (${problem}); remove it (it holds throwaway test passwords) and run again`);
	return dir;
};

// A descriptor file's text, after checking that only this user can have written or read it.
export const readDescriptorFile = (file: string): string => {
	ensureDescriptorDir(false);
	const problem = insecurity(file, 'file');
	if (problem) throw new InsecureDescriptorError(`stack descriptor ${file} is not trusted (${problem})`);
	return readFileSync(file, 'utf8');
};

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

// Throws if the directory is not safe (the sweep must not act on descriptors anyone could have planted or removed).
export const stackDescriptors = (): DescriptorInfo[] => {
	const dir = ensureDescriptorDir(false);
	if (!existsSync(dir)) return [];
	const out: DescriptorInfo[] = [];
	for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
		const file = join(dir, name);
		try {
			const d = JSON.parse(readDescriptorFile(file)) as { project?: unknown; run?: unknown; persistent?: unknown; ownerPid?: unknown };
			if (typeof d.run !== 'string' || typeof d.project !== 'string') continue;
			const live = d.persistent === true || typeof d.ownerPid !== 'number' || pidAlive(d.ownerPid);
			out.push({ file, project: d.project, run: d.run, live });
		} catch {
			// not a descriptor, one being written, or one that is not trusted: never acted upon
		}
	}
	return out;
};

export const removeDescriptor = (info: DescriptorInfo): void => {
	rmSync(info.file, { force: true });
};
