// `corepack yarn check:licenses [--root <dir>] [--exceptions <file>] [--report <file>]` (M1-AC24; ADR-0009 A6, A8,
// A9). Yarn 4 has no `yarn licenses` command, so this reads the declared licence of every installed manifest
// (installedPackages.ts), lists it, and passes it only when the licence (an SPDX expression) is on ADR-0009's
// allow-list or the exact name@version has a reviewed exception. Returns the process exit code.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Output } from './checkPin.ts';
import { installedPackages, packageKey } from './installedPackages.ts';
import type { InstalledPackage } from './installedPackages.ts';
import { exceptionsRelativePath, loadExceptions } from './licenseExceptions.ts';
import { declaredLicence, isAllowedLicence, parseSpdx } from './spdx.ts';

const usage = 'usage: check:licenses [--root <dir>] [--exceptions <file>] [--report <file>]';

export type LicenceStatus = 'allowed' | 'exception' | 'denied';

export interface LicenceVerdict {
	name: string;
	version: string;
	// POSIX path of the package directory relative to the scanned root.
	path: string;
	// The declared licence (or the expression derived from a legacy form); null when none is declared.
	license: string | null;
	legacy: string | null;
	status: LicenceStatus;
	// Why a package is denied, for the failure line.
	reason: string | null;
}

export const evaluatePackage = (pkg: InstalledPackage, excepted: boolean): LicenceVerdict => {
	const declared = declaredLicence(pkg.manifest);
	const base = { name: pkg.name, version: pkg.version, path: pkg.rel, license: declared.expression, legacy: declared.legacy };
	let reason: string;
	if (pkg.manifestError !== null) {
		reason = `its package.json cannot be read (${pkg.manifestError})`;
	} else if (declared.expression === null) {
		reason = declared.legacy ? `no licence: a legacy ${declared.legacy} entry has no usable type` : 'no licence declared';
	} else {
		const expression = parseSpdx(declared.expression);
		if (expression && isAllowedLicence(expression)) return { ...base, status: 'allowed', reason: null };
		reason = expression ? `${declared.expression} is not on the ADR-0009 allow-list` : `${declared.expression} is not an SPDX licence expression`;
	}
	return excepted ? { ...base, status: 'exception', reason: null } : { ...base, status: 'denied', reason };
};

const display = (verdict: LicenceVerdict): string => {
	if (verdict.license === null) return verdict.legacy ? `(no licence: legacy ${verdict.legacy} without a usable type)` : '(no licence)';
	return verdict.legacy ? `${verdict.license} [legacy ${verdict.legacy}]` : verdict.license;
};

export const runCheckLicenses = (argv: string[], repoRoot: string, out: Output): number => {
	let root: string;
	let exceptionsPath: string;
	let reportPath: string | null;
	try {
		const { values } = parseArgs({
			args: argv,
			options: { root: { type: 'string' }, exceptions: { type: 'string' }, report: { type: 'string' } },
			strict: true,
			allowPositionals: false,
		});
		root = resolve(values.root ?? repoRoot);
		exceptionsPath = resolve(values.exceptions ?? join(repoRoot, exceptionsRelativePath));
		reportPath = values.report === undefined ? null : resolve(values.report);
	} catch (error) {
		out.error(`check:licenses: ${(error as Error).message}`);
		out.error(usage);
		return 2;
	}

	try {
		const exceptions = loadExceptions(exceptionsPath);
		const packages = installedPackages(root);
		const verdicts = packages.map(pkg => evaluatePackage(pkg, exceptions.entries.has(packageKey(pkg.name, pkg.version))));

		for (const v of verdicts) out.info(`${packageKey(v.name, v.version)}  ${display(v)}  ${v.status}  (${v.path})`);

		const problems: string[] = [];
		for (const v of verdicts) {
			if (v.status === 'denied') problems.push(`DENIED ${packageKey(v.name, v.version)} (${v.path}): ${v.reason}, and ${exceptionsPath} has no exception for it`);
		}
		problems.push(...exceptions.problems);
		const installedVersions = new Map<string, Set<string>>();
		for (const p of packages) installedVersions.set(p.name, (installedVersions.get(p.name) ?? new Set()).add(p.version));
		const unused: string[] = [];
		for (const [key, entry] of exceptions.entries) {
			const versions = installedVersions.get(entry.name);
			if (!versions) {
				unused.push(key);
			} else if (!versions.has(entry.version)) {
				problems.push(`${exceptionsPath}: the exception ${key} matches no installed copy; installed: ${[...versions].sort().map(v => packageKey(entry.name, v)).join(', ')}`);
			} else if (verdicts.some(v => v.name === entry.name && v.version === entry.version && v.status === 'allowed')) {
				out.info(`check:licenses: note: ${key} is allowed by the allow-list; its exception is not needed here`);
			}
		}

		if (reportPath !== null) {
			mkdirSync(dirname(reportPath), { recursive: true });
			const report = { packages: verdicts.map(v => ({ name: v.name, version: v.version, path: v.path, license: v.license, status: v.status })) };
			writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		}

		const counts = { allowed: 0, exception: 0, denied: 0 };
		for (const v of verdicts) counts[v.status]++;
		if (unused.length > 0) out.info(`check:licenses: note: ${unused.length} exception(s) match no package installed in ${root} (they may serve the upstream notices): ${unused.join(', ')}`);
		if (problems.length > 0) {
			out.error(`check:licenses: FAILED. ${problems.length} problem(s) in ${root} (allow-list: ADR-0009; exceptions: ${exceptionsPath}):`);
			for (const problem of problems) out.error(`  - ${problem}`);
			return 1;
		}
		out.info(`check:licenses: OK. ${verdicts.length} installed package(s) in ${root}: ${counts.allowed} allowed by ADR-0009's allow-list, ${counts.exception} by a reviewed exception in ${exceptionsPath}.`);
		return 0;
	} catch (error) {
		out.error(`check:licenses: ${(error as Error).message}`);
		return 1;
	}
};
