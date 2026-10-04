// `corepack yarn check:pin [--pin <file>] [--lockfile <file>]` (M1-AC2, M1-AC3; ADR-0005 §1).
// Validates the pin file and checks yarn.lock against it. Returns the process exit code.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkLockfile, parseLockfile } from './lockfile.ts';
import { readPinFile } from './pin.ts';
import { pinRelativePath } from './repoRoot.ts';

export interface Output {
	info: (line: string) => void;
	error: (line: string) => void;
}

export const runCheckPin = (argv: string[], repoRoot: string, out: Output): number => {
	let pinPath: string;
	let lockfilePath: string;
	try {
		const { values } = parseArgs({
			args: argv,
			options: { pin: { type: 'string' }, lockfile: { type: 'string' } },
			strict: true,
			allowPositionals: false,
		});
		pinPath = resolve(values.pin ?? join(repoRoot, pinRelativePath));
		lockfilePath = resolve(values.lockfile ?? join(repoRoot, 'yarn.lock'));
	} catch (error) {
		out.error(`check:pin: ${(error as Error).message}`);
		out.error('usage: check:pin [--pin <file>] [--lockfile <file>]');
		return 2;
	}

	const { pin, problems } = readPinFile(pinPath);
	if (!pin) {
		out.error(`check:pin: ${pinPath} is not a valid upstream pin (ADR-0005):`);
		for (const problem of problems) out.error(`  - ${problem}`);
		out.error('check:pin: the lockfile was not checked because the pin is invalid.');
		return 1;
	}

	let lockText: string;
	try {
		lockText = readFileSync(lockfilePath, 'utf8');
	} catch (error) {
		out.error(`check:pin: cannot read the lockfile ${lockfilePath} (${(error as Error).message})`);
		return 1;
	}
	const lockProblems = checkLockfile(parseLockfile(lockText), pin, lockfilePath);
	if (lockProblems.length > 0) {
		out.error(`check:pin: ${lockfilePath} does not match the pin ${pinPath} (ADR-0005 §1):`);
		for (const problem of lockProblems) out.error(`  - ${problem}`);
		return 1;
	}

	out.info(`check:pin: OK. ${pinPath}: minor ${pin.minor}, web ${pin.web.tag} (${pin.web.commit}), cli ${pin.cli.npm}@${pin.cli.version}, server ${pin.server.image}:${pin.server.tag}, syncVersion ${pin.syncVersion}.`);
	out.info(`check:pin: OK. ${lockfilePath} resolves ${pin.cli.npm} to ${pin.cli.version} and every lockstep @joplin/* package to ${pin.minor}.x.`);
	return 0;
};
