// The licence-header half of `check:no-upstream-copy` (ADR-0009 A5, A10; M1-AC25). A tracked file of any size fails
// when it carries upstream's licence header together with upstream's copyright line:
// - the header is line 1 of upstream:LICENSE at web.commit (the repository licence statement);
// - the copyright line is `Copyright (c) <years> <holder>`, with the holder of upstream:LICENSE's own copyright line
//   and any single year or range (an older copy carries older years).
// Both strings are derived from upstream:LICENSE at the pin, never hard-coded, and matched as whole lines after a
// comment prefix (`//`, `#`, ` *`, …) and surrounding whitespace, in any file type.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, trackedFiles } from './upstreamCopy.ts';

export interface UpstreamLicence {
	header: string;
	holder: string;
}

const yearsPattern = String.raw`\d{4}(?:\s*[-–,]\s*\d{4})*`;
const copyrightPattern = new RegExp(String.raw`^Copyright \(c\) ${yearsPattern}\s+(\S.*?)\.?$`, 'i');

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A line without its comment prefix (`//`, `#`, `*`, `/*`, `<!--`, `;`, `--`, `>`), its comment suffix and the
// surrounding whitespace.
export const stripCommentMarkers = (line: string): string => line
	.replace(/^\s*(?:\/\/+|#+|\/\*+!?|\*+|<!--|;+|--|>)?\s*/, '')
	.replace(/\s*(?:\*\/|-->)?\s*$/, '');

// Reads the header and the copyright holder from the text of upstream:LICENSE.
export const parseUpstreamLicence = (text: string, label = 'upstream:LICENSE'): UpstreamLicence => {
	const lines = text.split(/\r?\n/);
	const header = lines.find(line => line.trim() !== '')?.trim() ?? '';
	if (header === '') throw new Error(`${label} is empty; the licence-header check cannot run`);
	const holder = lines.map(line => copyrightPattern.exec(line.trim())).find(match => match !== null)?.[1];
	if (!holder) throw new Error(`${label} has no "Copyright (c) <years> <holder>" line; the licence-header check cannot run`);
	return { header, holder };
};

export const upstreamLicence = (gitDir: string, commit: string): UpstreamLicence =>
	parseUpstreamLicence(git(gitDir, ['cat-file', 'blob', `${commit}:LICENSE`]).toString('utf8'), `upstream:LICENSE at ${commit}`);

// True when `content` has both the header line and a copyright line of the holder (any years).
export const hasUpstreamLicenceHeader = (content: string, licence: UpstreamLicence): boolean => {
	if (!content.includes(licence.header)) return false;
	const holderCopyright = new RegExp(String.raw`^Copyright \(c\) ${yearsPattern}\s+${escapeRegExp(licence.holder)}\.?$`, 'i');
	let header = false;
	let copyright = false;
	for (const raw of content.split(/\r?\n/)) {
		const line = stripCommentMarkers(raw);
		if (line === licence.header) header = true;
		else if (holderCopyright.test(line)) copyright = true;
		if (header && copyright) return true;
	}
	return false;
};

// The tracked regular files of `root` (any size) that carry upstream's licence header and copyright line.
export const findLicenceHeaders = (root: string, licence: UpstreamLicence): string[] => {
	const found: string[] = [];
	for (const path of trackedFiles(root)) {
		const absolute = join(root, path);
		try {
			if (!lstatSync(absolute).isFile()) continue;
		} catch {
			continue; // tracked but deleted in the working tree
		}
		if (hasUpstreamLicenceHeader(readFileSync(absolute, 'utf8'), licence)) found.push(path);
	}
	return found;
};
