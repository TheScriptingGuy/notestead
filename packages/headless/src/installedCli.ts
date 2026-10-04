// Locates the Joplin CLI installed as a dependency of a package (ADR-0005 §1: "joplin" pinned exactly in
// packages/headless/package.json). The supervisor uses the result to spawn the CLI and to compare its version with
// the pin before it starts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export interface InstalledCli {
	name: string;
	version: string;
	// Absolute path of the CLI's executable script (the package's "bin").
	binPath: string;
}

interface CliManifest {
	name?: unknown;
	version?: unknown;
	bin?: unknown;
}

const binOf = (manifest: CliManifest, packageName: string): string | null => {
	if (typeof manifest.bin === 'string') return manifest.bin;
	if (manifest.bin !== null && typeof manifest.bin === 'object') {
		const entry = (manifest.bin as Record<string, unknown>)[packageName];
		if (typeof entry === 'string') return entry;
	}
	return null;
};

// Resolves `packageName` the way Node would from `packageDir` (honouring node_modules hoisting).
export const findInstalledCli = (packageDir: string, packageName: string): InstalledCli => {
	const requireFromPackage = createRequire(join(resolve(packageDir), 'package.json'));
	let manifestPath: string;
	try {
		manifestPath = requireFromPackage.resolve(`${packageName}/package.json`);
	} catch {
		throw new Error(`The CLI package "${packageName}" is not installed for ${packageDir}; run \`corepack yarn install\``);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CliManifest;
	const bin = binOf(manifest, packageName);
	if (typeof manifest.version !== 'string' || bin === null) {
		throw new Error(`${manifestPath} does not declare a version and a "${packageName}" bin`);
	}
	return {
		name: typeof manifest.name === 'string' ? manifest.name : packageName,
		version: manifest.version,
		binPath: resolve(dirname(manifestPath), bin),
	};
};
