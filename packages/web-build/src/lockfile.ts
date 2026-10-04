// Checks that yarn.lock resolves the pinned CLI and its @joplin/* packages as ADR-0005 §1 requires:
// - the CLI package (pin cli.npm, "joplin") resolves to exactly cli.version;
// - every lockstep @joplin/* package resolves to a version inside the pin's minor;
// - the CLI and every @joplin/* package (forks included) resolve from the npm registry: `resolution:` is exactly
//   `<name>@npm:<version>` (M1-AC26). git, github, http(s) tarballs, file, link, portal, exec and patch all fail.
// The independently versioned upstream forks (@joplin/fork-*, @joplin/turndown*) follow their own version lines
// and are exempt (docs/test-plans/M1-S1.md, interpretation 1). Any other @joplin/* package is checked (fail closed).
import type { Pin } from './pin.ts';

export interface LockEntry {
	// The descriptor key as written in yarn.lock, e.g. "@joplin/lib@npm:^3.7.1, @joplin/lib@npm:~3.7".
	key: string;
	name: string;
	version: string;
	resolution: string;
}

const unquote = (value: string): string => value.trim().replace(/^"(.*)"$/, '$1');

// The package name of a locator or descriptor such as "@joplin/lib@npm:3.7.1" or "joplin@npm:3.7.1".
export const packageNameOf = (locator: string): string => {
	const at = locator.indexOf('@', locator.startsWith('@') ? 1 : 0);
	return at < 0 ? locator : locator.slice(0, at);
};

// Parses the entries of a Yarn Berry lockfile (the subset of its YAML used for package entries: top-level keys
// followed by two-space-indented `version:` and `resolution:` fields). Entries without a resolution are skipped.
export const parseLockfile = (text: string): LockEntry[] => {
	const entries: LockEntry[] = [];
	let current: { key: string; version?: string; resolution?: string } | null = null;
	const flush = (): void => {
		if (current?.resolution !== undefined && current.key !== '__metadata') {
			entries.push({
				key: current.key,
				name: packageNameOf(current.resolution),
				version: current.version ?? '',
				resolution: current.resolution,
			});
		}
		current = null;
	};

	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('#') || line.trim() === '') continue;
		if (!line.startsWith(' ')) {
			flush();
			current = { key: unquote(line.replace(/:\s*$/, '')) };
			continue;
		}
		const field = /^ {2}(version|resolution):\s*(.+)$/.exec(line);
		if (field && current) {
			if (field[1] === 'version') current.version = unquote(field[2]);
			else current.resolution = unquote(field[2]);
		}
	}
	flush();
	return entries;
};

// The protocol of a resolution such as "@joplin/lib@npm:3.7.1" (npm), "joplin@patch:joplin@npm%3A3.7.1#…" (patch)
// or "@joplin/lib@https://github.com/…" (https). "unknown" when the locator has no protocol.
export const resolutionProtocol = (resolution: string): string => {
	const reference = resolution.slice(packageNameOf(resolution).length + 1);
	return /^([a-z][a-z0-9+.-]*):/i.exec(reference)?.[1].toLowerCase() ?? 'unknown';
};

export const isIndependentlyVersioned = (name: string): boolean =>
	name.startsWith('@joplin/fork-') || name.startsWith('@joplin/turndown');

// Returns one message per problem, each naming the package and the offending resolved version.
export const checkLockfile = (entries: LockEntry[], pin: Pin, lockfileLabel: string): string[] => {
	const problems: string[] = [];
	const cliName = pin.cli.npm;

	const cliEntries = entries.filter(entry => entry.name === cliName);
	if (cliEntries.length === 0) {
		problems.push(`${cliName}: ${lockfileLabel} has no entry for the pinned CLI package "${cliName}" (cli.npm); expected it to resolve to exactly ${pin.cli.version} (cli.version)`);
	}
	for (const entry of cliEntries) {
		if (entry.version !== pin.cli.version) {
			problems.push(`${cliName}: ${lockfileLabel} resolves "${entry.key}" to ${entry.version}, expected exactly ${pin.cli.version} (cli.version)`);
		}
	}

	const minorPrefix = `${pin.minor}.`;
	for (const entry of entries) {
		if (!entry.name.startsWith('@joplin/') || isIndependentlyVersioned(entry.name)) continue;
		if (!entry.version.startsWith(minorPrefix)) {
			problems.push(`${entry.name}: ${lockfileLabel} resolves "${entry.key}" to ${entry.version}, expected ${pin.minor}.x (the pin's minor)`);
		}
	}

	// Read from `resolution:`, never from the key: root `resolutions` rewrite the resolution, not the requested range.
	for (const entry of entries) {
		if (entry.name !== cliName && !entry.name.startsWith('@joplin/')) continue;
		if (entry.resolution === `${entry.name}@npm:${entry.version}`) continue;
		const protocol = resolutionProtocol(entry.resolution);
		const detail = protocol === 'npm' ? `does not match its version ${entry.version}` : `uses the ${protocol} protocol`;
		problems.push(`${entry.name}: ${lockfileLabel} resolves "${entry.key}" to "${entry.resolution}", which ${detail}; ${cliName} and every @joplin/* package must resolve from the npm registry as ${entry.name}@npm:<version>`);
	}

	return problems;
};
