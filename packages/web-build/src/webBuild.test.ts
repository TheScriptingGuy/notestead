// The commands end to end, except the upstream recipe itself: `build` runs against a local upstream-like repository
// (fetched by commit over file://) with an injected runner standing in for `corepack yarn install` / `yarn web`.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, describeCommand, recipe, workMarker } from './build.ts';
import type { CommandSpec } from './build.ts';
import { gitRepo, pinFor, removeTempDirs, repoRoot, tempDir, upstreamRepo, webpackFiles, writeFiles } from './testing/fixtures.ts';
import { hashFiles } from './tree.ts';
import { runWebBuild } from './webBuild.ts';

interface Captured {
	info: string[];
	error: string[];
}

const run = async (argv: string[], options: { arch?: string; env?: NodeJS.ProcessEnv; runner?: (spec: CommandSpec) => number | null; cacheDir?: string } = {}) => {
	const captured: Captured = { info: [], error: [] };
	const code = await runWebBuild(argv, {
		repoRoot,
		out: { info: line => captured.info.push(line), error: line => captured.error.push(line) },
		cacheDir: options.cacheDir ?? tempDir('cache'),
		runner: options.runner,
		arch: options.arch ?? 'x64',
		env: options.env ?? { NOTESTEAD_SOURCE_REPO: 'https://example.org/notestead' },
	});
	return { code, ...captured };
};

const writePin = (repo: string, commit: string): string => {
	const path = join(tempDir('pin'), 'joplin-version.json');
	writeFileSync(path, JSON.stringify(pinFor(repo, commit)));
	return path;
};

// Stands in for the upstream recipe: `yarn web` copies public/ into dist/ and adds webpack outputs.
const fakeRecipe = (calls: CommandSpec[]) => (spec: CommandSpec): number => {
	calls.push(spec);
	if (spec.args.join(' ') === 'yarn web') {
		const dist = join(spec.cwd, 'web', 'dist');
		mkdirSync(dist, { recursive: true });
		cpSync(join(spec.cwd, 'web', 'public'), dist, { recursive: true });
		writeFiles(dist, webpackFiles());
	}
	return 0;
};

describe('webBuild', () => {
	afterAll(removeTempDirs);

	test('rejects unknown commands, options of other commands and missing arguments with exit 2', async () => {
		expect((await run(['frobnicate'])).code).toBe(2);
		const wrongOption = await run(['overlay', '/tmp/x', '--out', '/tmp/y']);
		expect(wrongOption).toMatchObject({ code: 2, error: ['overlay: option --out is not valid for overlay', expect.stringContaining('usage: overlay <dist>')] });
		expect((await run(['package', '/tmp/x'])).error[0]).toBe('package: --out <dir> is required');
		expect((await run(['verify'])).code).toBe(2);
		expect((await run(['build', 'extra', '--out', '/tmp/y'])).code).toBe(2);
	});

	test('names an invalid pin file', async () => {
		const path = join(tempDir('pin'), 'bad.json');
		writeFileSync(path, '{}');
		const result = await run(['overlay', '/tmp/x', '--pin', path]);
		expect(result.code).toBe(1);
		expect(result.error[0]).toBe(`overlay: ${path} is not a valid upstream pin (run \`corepack yarn check:pin\`):`);
	});

	test('build checks out the pinned commit, runs the recipe, overlays, verifies and packages', async () => {
		const upstream = upstreamRepo();
		const work = join(tempDir('work'), 'joplin');
		const out = join(tempDir('out'), 'out');
		const calls: CommandSpec[] = [];
		const result = await run(['build', '--out', out, '--work', work, '--pin', writePin(upstream.url, upstream.commit)], { runner: fakeRecipe(calls) });

		expect(result.error).toEqual([]);
		expect(result.code).toBe(0);
		expect(calls.map(c => [c.cwd, c.command, ...c.args])).toEqual([
			[work, 'corepack', 'yarn', 'install'],
			[join(work, 'packages', 'app-mobile'), 'corepack', 'yarn', 'web'],
		]);
		expect(calls[0].env).toEqual({ SKIP_ONENOTE_CONVERTER_BUILD: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
		expect(result.info).toContain(`+ (cd ${join(work, 'packages', 'app-mobile')} && SKIP_ONENOTE_CONVERTER_BUILD=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack yarn web)`);
		expect(readdirSync(out).sort()).toEqual(['SHA256SUMS', 'bundle-manifest.json', 'web-bundle-v9.9.9.tar.zst']);
		const manifest = JSON.parse(readFileSync(join(out, 'bundle-manifest.json'), 'utf8'));
		const paths: string[] = manifest.files.map((file: { path: string }) => file.path);
		expect(paths).toEqual(expect.arrayContaining(['app.bundle.js', 'source.html', 'icons/icon-512.png']));
		expect(paths.some(path => path.startsWith('screenshots/'))).toBe(false);
		expect(readFileSync(join(work, workMarker), 'utf8')).toContain(upstream.url);
		expect(readFileSync(join(work, 'packages/app-mobile/web/dist/source.html'), 'utf8')).toContain('https://example.org/notestead/tree/');

		expect(result.info).toContain('build: the upstream recipe left every tracked file unchanged');
	});

	test('build restores a reused checkout: local edits and untracked files never reach the artifact', async () => {
		const upstream = upstreamRepo();
		const work = join(tempDir('work'), 'joplin');
		const out = join(tempDir('out'), 'out');
		const pinPath = writePin(upstream.url, upstream.commit);
		expect((await run(['build', '--out', out, '--work', work, '--pin', pinPath], { runner: fakeRecipe([]) })).code).toBe(0);

		const publicDir = join(work, 'packages/app-mobile/web/public');
		writeFileSync(join(publicDir, 'index.html'), `${readFileSync(join(publicDir, 'index.html'), 'utf8')}<!-- LOCALLY MODIFIED -->\n`);
		writeFiles(publicDir, { 'extra.js': 'untracked local file' });
		writeFiles(work, { 'node_modules/kept.txt': 'ignored install output', 'packages/app-mobile/web/dist/stale.js': 'from an earlier build' });
		const again = await run(['build', '--out', out, '--work', work, '--pin', pinPath], { runner: fakeRecipe([]) });

		expect(again.error).toEqual([]);
		expect(again.code).toBe(0);
		expect(readFileSync(join(work, 'packages/app-mobile/web/dist/index.html'), 'utf8')).not.toContain('LOCALLY MODIFIED');
		const manifest = JSON.parse(readFileSync(join(out, 'bundle-manifest.json'), 'utf8'));
		expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain('extra.js');
		expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain('stale.js');
		expect(existsSync(join(work, 'node_modules/kept.txt'))).toBe(true);
		expect(existsSync(join(work, workMarker))).toBe(true);
		expect(again.info).toContain(`build: reusing the checkout of ${upstream.commit} in ${work}; restoring its tracked files and removing untracked ones (ignored files such as node_modules are kept)`);
	});

	test('build refuses a non-empty --work it did not create, changing nothing in it', async () => {
		const upstream = upstreamRepo();
		const pinPath = writePin(upstream.url, upstream.commit);
		const plain = tempDir('precious');
		writeFiles(plain, { 'precious/notes.txt': 'keep me', '.hidden': 'keep me too' });
		const clone = gitRepo({ 'tracked.txt': 'committed' }).dir;
		writeFiles(clone, { 'tracked.txt': 'uncommitted edit', 'untracked.txt': 'keep me' });

		for (const work of [plain, clone]) {
			const before = hashFiles(work);
			const calls: CommandSpec[] = [];
			const out = join(tempDir('out'), 'out');
			const result = await run(['build', '--out', out, '--work', work, '--pin', pinPath], { runner: fakeRecipe(calls) });
			expect(result.code).toBe(1);
			expect(result.error[0]).toBe(`build: refusing to use ${work} as the build work directory: it is not empty and was not created by \`build\` (no ${workMarker} marker). Pass a new or empty directory with --work; nothing in ${work} was changed.`);
			expect(hashFiles(work)).toEqual(before);
			expect(calls).toEqual([]);
			expect(existsSync(out)).toBe(false);
		}
		expect(existsSync(join(plain, '.git'))).toBe(false);
	});

	test('build takes an existing empty --work, marks it, and reuses it on the next run', async () => {
		const upstream = upstreamRepo();
		const pinPath = writePin(upstream.url, upstream.commit);
		const work = tempDir('empty-work');
		const out = join(tempDir('out'), 'out');
		expect((await run(['build', '--out', out, '--work', work, '--pin', pinPath], { runner: fakeRecipe([]) })).code).toBe(0);
		expect(existsSync(join(work, workMarker))).toBe(true);
		const again = await run(['build', '--out', out, '--work', work, '--pin', pinPath], { runner: fakeRecipe([]) });
		expect(again.code).toBe(0);
		expect(again.info).toContain(`build: reusing the checkout of ${upstream.commit} in ${work}; restoring its tracked files and removing untracked ones (ignored files such as node_modules are kept)`);
	});

	test('build stops at a failing recipe step and never packages', async () => {
		const upstream = upstreamRepo();
		const out = join(tempDir('out'), 'out');
		const result = await run(['build', '--out', out, '--work', join(tempDir('work'), 'w'), '--pin', writePin(upstream.url, upstream.commit)], { runner: () => 1 });
		expect(result.code).toBe(1);
		expect(result.error[0]).toMatch(/^build: the upstream recipe step `corepack yarn install` failed \(exit 1\)/);
		expect(existsSync(out)).toBe(false);
	});

	test('build refuses to start on arm64 without the interlock, and applies the S1 conditions with it', async () => {
		const calls: CommandSpec[] = [];
		const refused = await run(['build', '--out', join(tempDir('out'), 'out')], { arch: 'arm64', runner: fakeRecipe(calls) });
		expect(refused.code).toBe(1);
		expect(refused.error[0]).toContain('Set NOTESTEAD_ALLOW_ARM64_WEB_BUILD=1');
		expect(calls).toEqual([]);

		const [install] = recipe('/w', { arch: 'arm64', env: {} });
		expect(install.env).toEqual({ SKIP_ONENOTE_CONVERTER_BUILD: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', BUILD_SEQUENCIAL: '1', NODE_OPTIONS: '--max-old-space-size=3072' });
		expect(describeCommand(install)).toBe('+ (cd /w && SKIP_ONENOTE_CONVERTER_BUILD=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 BUILD_SEQUENCIAL=1 NODE_OPTIONS=--max-old-space-size=3072 corepack yarn install)');
	});

	test('the recipe environment drops the variables yarn injects into our own scripts', () => {
		expect(childEnv({ PATH: '/bin', npm_package_name: 'web-build', YARN_IGNORE_PATH: '1', BERRY_BIN_FOLDER: '/x', INIT_CWD: '/r', PROJECT_CWD: '/r', HOME: '/h' }, { A: '1' }))
			.toEqual({ PATH: '/bin', HOME: '/h', A: '1' });
	});
});
