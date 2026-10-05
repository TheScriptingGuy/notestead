// Builds the `web` image under test for the M1-S4 contract suite (docs/test-plans/M1-S4.md §Image contract), along the
// production path of M1-AC28: packaged artifact → `web-build import` → dist/ → `podman build` with that dist.
// - Artifact: NOTESTEAD_WEB_ARTIFACT (a CI-built or locally packaged artifact dir) or, by default, fixture F3 packaged
//   with `web-build package` into a temp dir.
// - Image: `podman build -f deploy/web/Containerfile --build-context dist=<dist> -t <tag> deploy/web`.
// Run as a script by the Jest contract globalSetup (Jest cannot load these ESM helpers):
//   node tests/acceptance/support/webImage.mts <work-dir> <image-tag>
// It prints one JSON line: {"image", "dist", "artifact", "source"} or {"error"}. Erasable TypeScript only.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, repoRoot, run, removeDir } from './repo.mts';
import { overlaidServable, runImport, webBuild } from './webImport.mts';

export const logStory = 'm1-s4-image';
export const containerfile = join(repoRoot, 'deploy', 'web', 'Containerfile');
export const buildContext = join(repoRoot, 'deploy', 'web');

export interface WebImage {
	image: string;
	dist: string;
	artifact: string;
	source: 'NOTESTEAD_WEB_ARTIFACT' | 'fixture F3';
}

// What the story must provide before the image can be built at all (so RED names every missing piece).
export const missingPieces = (): string[] => {
	const missing: string[] = [];
	const scripts = readJson<{ scripts?: Record<string, string> }>(join(repoRoot, 'packages', 'web-build', 'package.json')).scripts ?? {};
	if (!scripts.import) missing.push('the `import` script of packages/web-build (M1-AC28; docs/test-plans/M1-S4.md §Command contracts)');
	if (!existsSync(containerfile)) missing.push('deploy/web/Containerfile (docs/test-plans/M1-S4.md §Image contract)');
	return missing;
};

export const prepareWebImage = (work: string, tag: string): WebImage => {
	const missing = missingPieces();
	if (missing.length > 0) throw new Error(`Contract (docs/test-plans/M1-S4.md): missing ${missing.join('; ')}`);
	mkdirSync(work, { recursive: true });

	let artifact: string;
	let source: WebImage['source'];
	if (process.env.NOTESTEAD_WEB_ARTIFACT) {
		artifact = resolve(process.env.NOTESTEAD_WEB_ARTIFACT);
		source = 'NOTESTEAD_WEB_ARTIFACT';
	} else {
		const { dir } = overlaidServable('image', 'm1s4-image-f3', logStory);
		artifact = join(work, 'artifact');
		const packaged = webBuild('image-package-F3', 'package', [dir, '--out', artifact], {}, logStory);
		if (packaged.code !== 0) throw new Error(`web-build package failed (log: ${packaged.logFile})\n${packaged.output.slice(-2000)}`);
		removeDir(dir);
		source = 'fixture F3';
	}

	const dist = join(work, 'dist');
	const imported = runImport('image-import', artifact, dist, [], logStory);
	if (imported.code !== 0) throw new Error(`web-build import failed (log: ${imported.logFile})\n${imported.output.slice(-2000)}`);

	const built = run(logStory, 'image-podman-build', 'podman', [
		'build', '-f', containerfile, '--build-context', `dist=${dist}`,
		'--label', 'io.github.thescriptingguy.notestead.test=contract', '-t', tag, buildContext,
	], { timeoutMs: 15 * 60_000 });
	if (built.code !== 0) throw new Error(`podman build failed (log: ${built.logFile})\n${built.output.slice(-3000)}`);
	return { image: tag, dist, artifact, source };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [work, tag] = process.argv.slice(2);
	try {
		if (!work || !tag) throw new Error('usage: node tests/acceptance/support/webImage.mts <work-dir> <image-tag>');
		process.stdout.write(`${JSON.stringify(prepareWebImage(resolve(work), tag))}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
		process.exitCode = 1;
	}
}
