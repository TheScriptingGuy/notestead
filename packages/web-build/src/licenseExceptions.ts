// The reviewed licence exception list, packages/web-build/license-exceptions.json (ADR-0009 A6; M1-AC24, M1-AC29).
// One file serves `check:licenses` (this repo's tree) and `notices` (upstream's tree); an entry applies wherever its
// exact name@version is installed. Schema (docs/test-plans/M1-S9.md):
//   { "//"?: …, "exceptions": [ { name, version (exact), license, evidence, reason, noticeText?, prepublishBlocker? } ] }
// `license` is the licence as established, or "UNKNOWN" (then `prepublishBlocker` must be true: the M5 pre-publish gate
// reads it). `noticeText` is the text third-party-notices.txt uses when the package ships no licence file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageKey } from './installedPackages.ts';

export const exceptionsRelativePath = join('packages', 'web-build', 'license-exceptions.json');

export interface LicenceException {
	name: string;
	version: string;
	license: string;
	evidence: string;
	reason: string;
	noticeText: string | null;
	prepublishBlocker: boolean;
}

export interface ExceptionList {
	// Valid entries by name@version.
	entries: Map<string, LicenceException>;
	// One message per problem, each naming the entry's package. Invalid entries are not applied.
	problems: string[];
}

const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const entryKeys = new Set(['name', 'version', 'license', 'evidence', 'reason', 'noticeText', 'prepublishBlocker']);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export const parseExceptions = (data: unknown, label: string): ExceptionList => {
	const entries = new Map<string, LicenceException>();
	const problems: string[] = [];
	if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray((data as { exceptions?: unknown }).exceptions)) {
		return { entries, problems: [`${label}: must be an object with an "exceptions" array`] };
	}
	for (const key of Object.keys(data)) {
		if (key !== 'exceptions' && !key.startsWith('//')) problems.push(`${label}: unknown top-level key ${JSON.stringify(key)}`);
	}
	(data as { exceptions: unknown[] }).exceptions.forEach((raw, index) => {
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			problems.push(`${label} exceptions[${index}]: must be an object`);
			return;
		}
		const e = raw as Record<string, unknown>;
		const id = `${nonEmpty(e.name) ? e.name : '(no name)'}@${typeof e.version === 'string' ? e.version : '(no version)'}`;
		const at = `${label} exceptions[${index}] ${id}`;
		const before = problems.length;
		if (!nonEmpty(e.name)) problems.push(`${at}: "name" must be a non-empty string`);
		if (!nonEmpty(e.version)) problems.push(`${at}: "version" must be a non-empty string`);
		else if (!exactVersion.test(e.version)) problems.push(`${at}: "version" must be an exact version (no range, so a bump forces a re-review), got ${JSON.stringify(e.version)}`);
		for (const field of ['license', 'evidence', 'reason'] as const) {
			if (!nonEmpty(e[field])) problems.push(`${at}: "${field}" must be a non-empty string`);
		}
		if (e.noticeText !== undefined && !nonEmpty(e.noticeText)) problems.push(`${at}: "noticeText", when given, must be a non-empty string`);
		if (e.prepublishBlocker !== undefined && typeof e.prepublishBlocker !== 'boolean') problems.push(`${at}: "prepublishBlocker" must be true or false`);
		if (e.license === 'UNKNOWN' && e.prepublishBlocker !== true) problems.push(`${at}: "license" is "UNKNOWN", so "prepublishBlocker" must be true (M5 pre-publish gate)`);
		for (const key of Object.keys(e)) {
			if (!entryKeys.has(key) && !key.startsWith('//')) problems.push(`${at}: unknown key ${JSON.stringify(key)}`);
		}
		if (problems.length > before) return;
		const entry: LicenceException = {
			name: e.name as string,
			version: e.version as string,
			license: e.license as string,
			evidence: e.evidence as string,
			reason: e.reason as string,
			noticeText: typeof e.noticeText === 'string' ? e.noticeText : null,
			prepublishBlocker: e.prepublishBlocker === true,
		};
		const key = packageKey(entry.name, entry.version);
		if (entries.has(key)) problems.push(`${at}: ${key} has more than one entry`);
		else entries.set(key, entry);
	});
	return { entries, problems };
};

export const loadExceptions = (path: string): ExceptionList => {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		return { entries: new Map(), problems: [`${path}: cannot read the exception list (${(error as Error).message})`] };
	}
	return parseExceptions(data, path);
};
