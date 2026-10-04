// Reads and validates upstream/joplin-version.json, the single upstream version pin (ADR-0005 §1).
// Every problem is reported with the dotted path of the field it concerns, so a failing check says what to fix.
import { readFileSync } from 'node:fs';

export interface Pin {
	minor: string;
	web: { repo: string; branch: string; tag: string; commit: string };
	cli: { npm: string; version: string };
	server: { image: string; tag: string };
	syncVersion: number;
}

export interface PinResult {
	pin: Pin | null;
	problems: string[];
}

const minorPattern = /^\d+\.\d+$/;
const commitPattern = /^[0-9a-f]{40}$/;
// An exact semver version: X.Y.Z with an optional pre-release. No ranges, wildcards or partial versions.
const exactVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const describeValue = (value: unknown): string => JSON.stringify(value) ?? String(value);

export const validatePin = (data: unknown): PinResult => {
	const problems: string[] = [];

	if (!isObject(data)) {
		return { pin: null, problems: ['(root): the pin must be a JSON object'] };
	}

	// A missing or malformed section is reported once; its fields are then not checked (object is null).
	const section = (name: string): Record<string, unknown> | null => {
		const value = data[name];
		if (value === undefined) {
			problems.push(`${name}: required object is missing`);
			return null;
		}
		if (!isObject(value)) {
			problems.push(`${name}: must be an object, got ${describeValue(value)}`);
			return null;
		}
		return value;
	};

	// Returns the string value of a required, non-empty string field, or null after recording the problem.
	const requiredString = (object: Record<string, unknown> | null, path: string, key: string): string | null => {
		if (object === null) return null;
		const value = object[key];
		if (value === undefined) {
			problems.push(`${path}: required string is missing`);
			return null;
		}
		if (typeof value !== 'string') {
			problems.push(`${path}: must be a string, got ${describeValue(value)}`);
			return null;
		}
		if (value.trim() === '') {
			problems.push(`${path}: must not be empty`);
			return null;
		}
		return value;
	};

	const minor = requiredString(data, 'minor', 'minor');
	if (minor !== null && !minorPattern.test(minor)) {
		problems.push(`minor: must be MAJOR.MINOR (for example "3.7"), got ${describeValue(minor)}`);
	}

	const web = section('web');
	requiredString(web, 'web.repo', 'repo');
	requiredString(web, 'web.branch', 'branch');
	requiredString(web, 'web.tag', 'tag');
	const commit = requiredString(web, 'web.commit', 'commit');
	if (commit !== null && !commitPattern.test(commit)) {
		problems.push(`web.commit: must be a full commit SHA (exactly 40 lowercase hex characters), got ${describeValue(commit)}`);
	}

	const cli = section('cli');
	requiredString(cli, 'cli.npm', 'npm');
	const cliVersion = requiredString(cli, 'cli.version', 'version');
	if (cliVersion !== null) {
		if (!exactVersionPattern.test(cliVersion)) {
			problems.push(`cli.version: must be an exact version X.Y.Z (no range, wildcard or partial version), got ${describeValue(cliVersion)}`);
		} else if (minor !== null && minorPattern.test(minor) && !cliVersion.startsWith(`${minor}.`)) {
			problems.push(`cli.version: ${cliVersion} is outside the pinned minor ${minor} (ADR-0005 §2: same-minor skew policy)`);
		}
	}

	const server = section('server');
	requiredString(server, 'server.image', 'image');
	requiredString(server, 'server.tag', 'tag');

	const syncVersion = data.syncVersion;
	if (syncVersion === undefined) {
		problems.push('syncVersion: required integer is missing');
	} else if (typeof syncVersion !== 'number' || !Number.isInteger(syncVersion)) {
		problems.push(`syncVersion: must be an integer, got ${describeValue(syncVersion)}`);
	}

	return { pin: problems.length === 0 ? data as unknown as Pin : null, problems };
};

// Reads and validates a pin file. An unreadable or non-JSON file is reported with its path.
export const readPinFile = (path: string): PinResult => {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		return { pin: null, problems: [`${path}: cannot read the pin file (${(error as Error).message})`] };
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return { pin: null, problems: [`${path}: the pin file is not valid JSON (${(error as Error).message})`] };
	}
	return validatePin(data);
};
