// The `web-build` workspace commands (docs/test-plans/M1-S2.md §Command contracts; ADR-0001, ADR-0010):
//   overlay <dist> [--pin <file>]
//   verify [--upstream <git-dir>] [--pin <file>] <dist>
//   package <dist> --out <dir> [--pin <file>]
//   build --out <dir> [--work <dir>] [--pin <file>]
//   notices <upstream-tree> --bundle <dist> --out <file> [--exceptions <file>]   (docs/test-plans/M1-S9.md)
//   import <artifact-dir> --out <dist> [--pin <file>] [--upstream <git-dir>]      (docs/test-plans/M1-S4.md)
// Each returns the process exit code: 0 success, 1 failure, 2 usage error. Every failure names the offending path.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildUpstreamBundle, childEnv } from './build.ts';
import { importBundle } from './importBundle.ts';
import type { CommandRunner } from './build.ts';
import type { Output } from './checkPin.ts';
import { exceptionsRelativePath, loadExceptions } from './licenseExceptions.ts';
import { noticesFileName, writeNotices } from './notices.ts';
import { applyOverlay, loadOverlayConfig } from './overlay.ts';
import type { OverlayConfig } from './overlay.ts';
import { packageBundle } from './packageBundle.ts';
import { readPinFile } from './pin.ts';
import type { Pin } from './pin.ts';
import { ourRepoUrl, ourSource } from './provenance.ts';
import { pinRelativePath } from './repoRoot.ts';
import { renderSourceOffer } from './sourceOffer.ts';
import { loadStandardTexts } from './spdxTexts.ts';
import { listFiles, requireDirectory } from './tree.ts';
import { defaultCacheDir, ensureUpstreamTree } from './upstreamCopy.ts';
import { upstreamFile, upstreamIconHashes, upstreamPublicDir, verifyBundle } from './verify.ts';

export interface WebBuildDeps {
	repoRoot: string;
	out: Output;
	cacheDir?: string;
	runner?: CommandRunner;
	arch?: string;
	env?: NodeJS.ProcessEnv;
}

const usages: Record<string, string> = {
	overlay: 'overlay <dist> [--pin <file>]',
	verify: 'verify [--upstream <git-dir>] [--pin <file>] <dist>',
	package: 'package <dist> --out <dir> [--pin <file>]',
	build: 'build --out <dir> [--work <dir>] [--pin <file>]',
	notices: 'notices <upstream-tree> --bundle <dist> --out <file> [--exceptions <file>]',
	import: 'import <artifact-dir> --out <dist> [--pin <file>] [--upstream <git-dir>]',
};

class UsageError extends Error {}

const webBuildDir = (repoRoot: string): string => join(repoRoot, 'packages', 'web-build');

const readPin = (path: string): Pin => {
	const { pin, problems } = readPinFile(path);
	if (!pin) throw new Error(`${path} is not a valid upstream pin (run \`corepack yarn check:pin\`):\n  - ${problems.join('\n  - ')}`);
	return pin;
};

// The overlay configuration and the context its rules run in (rule sources and the source.html template).
const overlaySetup = (repoRoot: string, pin: Pin, env: NodeJS.ProcessEnv): { config: OverlayConfig; baseDir: string; templates: Record<string, (dist: string) => string> } => {
	const baseDir = webBuildDir(repoRoot);
	const config = loadOverlayConfig(join(baseDir, 'overlay.json'));
	const ours = ourSource(repoRoot);
	const ourRepo = ourRepoUrl(repoRoot, env);
	return {
		config,
		baseDir,
		templates: {
			sourceOffer: dist => renderSourceOffer({
				pin,
				ourRepo,
				ourCommit: ours.commit,
				ourDirty: ours.dirty,
				licenseFiles: listFiles(dist).filter(path => path.endsWith('.LICENSE.txt')),
				thirdPartyNotices: existsSync(join(dist, noticesFileName)),
			}),
		},
	};
};

const runOverlay = (dist: string, pin: Pin, deps: WebBuildDeps): void => {
	const { config, baseDir, templates } = overlaySetup(deps.repoRoot, pin, deps.env ?? process.env);
	for (const change of applyOverlay(dist, config, { baseDir, templates })) deps.out.info(`overlay: ${change}`);
	deps.out.info(`overlay: OK. Applied ${config.rules.length} rules to ${dist}.`);
};

// Throws when the bundle fails verification; the message lists every offending path.
const runVerify = (dist: string, pin: Pin, upstreamDir: string | null, deps: WebBuildDeps): void => {
	requireDirectory(dist, 'dist');
	const tree = ensureUpstreamTree(pin.web.repo, pin.web.commit, upstreamDir, deps.cacheDir ?? defaultCacheDir());
	if (tree.fetched) deps.out.info(`verify: fetched the upstream tree at ${pin.web.commit} (blobless) into ${tree.gitDir}`);
	const iconHashes = upstreamIconHashes(tree.gitDir, pin.web.commit);
	const config = loadOverlayConfig(join(webBuildDir(deps.repoRoot), 'overlay.json'));
	const environmentRule = config.rules.find(rule => rule.path === 'environment.js' && rule.action === 'replace' && rule.source);
	if (!environmentRule?.source) throw new Error('overlay.json has no "replace" rule for environment.js; verify cannot check dev mode');
	const problems = verifyBundle({
		dist,
		iconHashes,
		overlayEnvironment: readFileSync(join(webBuildDir(deps.repoRoot), ...environmentRule.source.split('/'))),
		upstreamIndexHtml: upstreamFile(tree.gitDir, pin.web.commit, `${upstreamPublicDir}/index.html`).toString('utf8'),
	});
	if (problems.length > 0) {
		throw new Error(`${dist} failed verification (${problems.length} problem(s), upstream ${pin.web.tag} ${pin.web.commit}):\n  - ${problems.join('\n  - ')}`);
	}
	deps.out.info(`verify: OK. ${dist}: no file matches the ${iconHashes.size} upstream icons at ${pin.web.tag} (${pin.web.commit}); environment.js is the overlay's; the CSP <meta> equals upstream's.`);
};

// Writes the third-party notices of the upstream tree `tree` and its built `bundle` to `out` (M1-AC29). Throws, naming
// every package without a notice, and writes nothing when any is missing.
const runNotices = (tree: string, bundle: string, out: string, exceptionsPath: string | undefined, deps: WebBuildDeps): void => {
	requireDirectory(tree, 'upstream tree');
	requireDirectory(bundle, '--bundle');
	const exceptionsFile = exceptionsPath ?? join(deps.repoRoot, exceptionsRelativePath);
	const result = writeNotices({
		tree,
		bundle,
		exceptions: loadExceptions(exceptionsFile),
		exceptionsLabel: exceptionsFile,
		texts: loadStandardTexts(webBuildDir(deps.repoRoot)),
	}, out);
	for (const note of result.notes) deps.out.info(`notices: note: ${note}`);
	if (result.problems.length > 0) {
		throw new Error(`${result.problems.length} package(s) of ${tree} cannot be given a notice; nothing was written to ${out} (ADR-0010; add a reviewed exception with a noticeText only after establishing the licence):\n  - ${result.problems.join('\n  - ')}`);
	}
	deps.out.info(`notices: OK. ${result.entries} entries written to ${out}.`);
};

const runPackage = async (dist: string, outDir: string, pin: Pin, deps: WebBuildDeps): Promise<void> => {
	requireDirectory(dist, 'dist');
	const ours = ourSource(deps.repoRoot);
	const result = await packageBundle(dist, outDir, pin, ours);
	deps.out.info(`package: OK. ${result.tarball} (${result.files} files, ${result.bytes} bytes before compression), SHA256SUMS and bundle-manifest.json in ${outDir}.`);
	if (ours.dirty) deps.out.info(`package: note: the working tree of ${deps.repoRoot} has uncommitted changes (bundle-manifest.json notestead.dirty = true).`);
};

// Installs a packaged artifact as a dist/ (M1-AC28); verify runs on the extracted bundle before it is installed.
const runImport = (artifactDir: string, out: string, pin: Pin, pinLabel: string, upstreamDir: string | null, deps: WebBuildDeps): void => {
	const result = importBundle({ artifactDir, out, pin, pinLabel, verify: dist => runVerify(dist, pin, upstreamDir, deps) });
	deps.out.info(`import: OK. ${result.files} files (${result.bytes} bytes) from ${result.tarball} installed in ${out} (upstream ${pin.web.tag}, ${pin.web.commit}).`);
};

const defaultRunner: CommandRunner = spec => {
	const result = spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: childEnv(process.env, spec.env), stdio: 'inherit' });
	if (result.error) throw new Error(`${spec.command} could not run in ${spec.cwd}: ${result.error.message}`);
	return result.status;
};

const runBuild = async (outDir: string, workOption: string | undefined, pin: Pin, deps: WebBuildDeps): Promise<void> => {
	const work = workOption ?? join(deps.cacheDir ?? defaultCacheDir(), 'web-build', pin.web.commit);
	deps.out.info(`build: upstream ${pin.web.repo} ${pin.web.tag} (${pin.web.commit}) in ${work}; artifact into ${outDir}`);
	const dist = buildUpstreamBundle({
		pin,
		work,
		runner: deps.runner ?? defaultRunner,
		log: line => deps.out.info(line),
		arch: deps.arch,
		env: deps.env,
	});
	runNotices(work, dist, join(dist, noticesFileName), undefined, deps);
	runOverlay(dist, pin, deps);
	runVerify(dist, pin, work, deps);
	await runPackage(dist, outDir, pin, deps);
};

export const runWebBuild = async (argv: string[], deps: WebBuildDeps): Promise<number> => {
	const [command, ...rest] = argv;
	const usage = usages[command ?? ''];
	if (!usage) {
		deps.out.error(`web-build: unknown command ${JSON.stringify(command)}; usage:\n  ${Object.values(usages).join('\n  ')}`);
		return 2;
	}
	try {
		const { values, positionals } = parseArgs({
			args: rest,
			options: {
				pin: { type: 'string' },
				out: { type: 'string' },
				work: { type: 'string' },
				upstream: { type: 'string' },
				bundle: { type: 'string' },
				exceptions: { type: 'string' },
			},
			strict: true,
			allowPositionals: true,
		});
		const allowed: Record<string, string[]> = {
			overlay: ['pin'], verify: ['pin', 'upstream'], package: ['pin', 'out'], build: ['pin', 'out', 'work'], notices: ['bundle', 'out', 'exceptions'], import: ['pin', 'out', 'upstream'],
		};
		for (const key of Object.keys(values)) {
			if (!allowed[command].includes(key)) throw new UsageError(`option --${key} is not valid for ${command}`);
		}
		const expectedPositionals = command === 'build' ? 0 : 1;
		if (positionals.length !== expectedPositionals) throw new UsageError(`expected ${expectedPositionals} positional argument(s), got ${positionals.length}`);
		if ((command === 'package' || command === 'build' || command === 'import') && values.out === undefined) throw new UsageError('--out <dir> is required');
		if (command === 'notices' && (values.out === undefined || values.bundle === undefined)) throw new UsageError('--bundle <dist> and --out <file> are required');

		const pinPath = resolve(values.pin ?? join(deps.repoRoot, pinRelativePath));
		const pin = readPin(pinPath);
		const dist = positionals.length === 1 ? resolve(positionals[0]) : '';
		if (command === 'notices') runNotices(dist, resolve(values.bundle ?? ''), resolve(values.out ?? ''), values.exceptions === undefined ? undefined : resolve(values.exceptions), deps);
		else if (command === 'overlay') runOverlay(dist, pin, deps);
		else if (command === 'verify') runVerify(dist, pin, values.upstream === undefined ? null : resolve(values.upstream), deps);
		else if (command === 'package') await runPackage(dist, resolve(values.out ?? ''), pin, deps);
		else if (command === 'import') runImport(dist, resolve(values.out ?? ''), pin, pinPath, values.upstream === undefined ? null : resolve(values.upstream), deps);
		else await runBuild(resolve(values.out ?? ''), values.work === undefined ? undefined : resolve(values.work), pin, deps);
		return 0;
	} catch (error) {
		const isUsage = error instanceof UsageError || (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS');
		for (const line of (error as Error).message.split('\n')) deps.out.error(`${command}: ${line}`);
		if (isUsage) {
			deps.out.error(`usage: ${usage}`);
			return 2;
		}
		return 1;
	}
};
