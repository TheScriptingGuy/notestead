// Entry point of the `headless` image (packages/headless/Containerfile). Run by Node's built-in type stripping.
// Configuration: JOPLIN_SERVER_URL, JOPLIN_USERNAME and the secret files /run/secrets/{joplin_password,
// e2ee_master_password}; the CLI profile is /data/profile; GET /healthz on :8090. See packages/headless/README.md.
import { join } from 'node:path';
import { findPinnedCli } from '../src/installedCli.ts';
import { runSupervisor } from '../src/supervisor.ts';

const write = (line: string): void => {
	process.stdout.write(`${line}\n`);
};

const main = async (): Promise<void> => {
	let cliBinPath: string;
	try {
		const cli = findPinnedCli(join(import.meta.dirname, '..'), 'joplin');
		cliBinPath = cli.binPath;
		write(`${new Date().toISOString()} Notestead headless for Joplin (unofficial): CLI ${cli.name} ${cli.version}`);
	} catch (error) {
		write(`${new Date().toISOString()} ${(error as Error).message}`);
		process.exitCode = 70;
		return;
	}
	const supervisor = await runSupervisor({
		env: process.env,
		cliBinPath,
		write,
		exit: code => {
			process.exitCode = code;
			// Children are stopped and the health server is closed at this point; nothing else should keep the loop.
			process.exit(code);
		},
	});
	if (!supervisor) return;
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void supervisor.shutdown(0));
	await supervisor.started;
};

main().catch((error: unknown) => {
	write(`${new Date().toISOString()} supervisor failed: ${(error as Error).message}`);
	process.exit(70);
});
