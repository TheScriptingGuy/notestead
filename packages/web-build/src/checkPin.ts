// `corepack yarn check:pin [--pin <file>] [--lockfile <file>] [--headless-manifest <file>]` (M1-AC2, M1-AC3,
// M1-AC26; ADR-0005 §1). Validates the pin file, checks yarn.lock against it and checks that the headless manifest
// depends on the CLI at exactly cli.version. Returns the process exit code.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkLockfile, parseLockfile } from './lockfile.ts';
import { readPinFile } from './pin.ts';
import type { Pin } from './pin.ts';
import { pinRelativePath } from './repoRoot.ts';

export interface Output {
	info: (line: string) => void;
	error: (line: string) => void;
}

const usage = 'usage: check:pin [--pin <file>] [--lockfile <file>] [--headless-manifest <file>]';

export const headlessManifestRelativePath = join('packages', 'headless', 'package.json');

// The headless image installs the CLI from this manifest (ADR-0005, ADR-0009 A4): `dependencies.<cli.npm>` must be
// exactly cli.version, never a range. Returns one message per problem, each naming the manifest and the field.
export const checkHeadlessManifest = (manifestPath: string, pin: Pin): string[] => {
	const field = `dependencies.${pin.cli.npm}`;
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		return [`${manifestPath}: cannot read ${field} (${(error as Error).message})`];
	}
	const dependencies = (data as { dependencies?: unknown } | null)?.dependencies;
	const value = dependencies !== null && typeof dependencies === 'object' ? (dependencies as Record<string, unknown>)[pin.cli.npm] : undefined;
	if (value === pin.cli.version) return [];
	const found = value === undefined ? 'is missing' : `is ${JSON.stringify(value)}`;
	return [`${manifestPath}: ${field} ${found}, expected exactly "${pin.cli.version}" (cli.version; no range)`];
};

export const runCheckPin = (argv: string[], repoRoot: string, out: Output): number => {
	let pinPath: string;
	let lockfilePath: string;
	let manifestPath: string;
	try {
		const { values } = parseArgs({
			args: argv,
			options: { 'pin': { type: 'string' }, 'lockfile': { type: 'string' }, 'headless-manifest': { type: 'string' } },
			strict: true,
			allowPositionals: false,
		});
		pinPath = resolve(values.pin ?? join(repoRoot, pinRelativePath));
		lockfilePath = resolve(values.lockfile ?? join(repoRoot, 'yarn.lock'));
		manifestPath = resolve(values['headless-manifest'] ?? join(repoRoot, headlessManifestRelativePath));
	} catch (error) {
		out.error(`check:pin: ${(error as Error).message}`);
		out.error(usage);
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
	const manifestProblems = checkHeadlessManifest(manifestPath, pin);
	if (lockProblems.length > 0) {
		out.error(`check:pin: ${lockfilePath} does not match the pin ${pinPath} (ADR-0005 §1):`);
		for (const problem of lockProblems) out.error(`  - ${problem}`);
	}
	if (manifestProblems.length > 0) {
		out.error(`check:pin: the headless manifest does not pin the CLI to cli.version of ${pinPath} (M1-AC26):`);
		for (const problem of manifestProblems) out.error(`  - ${problem}`);
	}
	if (lockProblems.length > 0 || manifestProblems.length > 0) return 1;

	out.info(`check:pin: OK. ${pinPath}: minor ${pin.minor}, web ${pin.web.tag} (${pin.web.commit}), cli ${pin.cli.npm}@${pin.cli.version}, server ${pin.server.image}:${pin.server.tag}, syncVersion ${pin.syncVersion}.`);
	out.info(`check:pin: OK. ${lockfilePath} resolves ${pin.cli.npm} to ${pin.cli.version}, every lockstep @joplin/* package to ${pin.minor}.x, and all of them from the npm registry.`);
	out.info(`check:pin: OK. ${manifestPath} depends on ${pin.cli.npm} at exactly ${pin.cli.version}.`);
	return 0;
};
