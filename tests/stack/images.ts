// The images a compose test stack runs (docs/test-plans/M1-S6.md §Images). Each comes from an environment variable
// when set (a prebuilt image: CI's, a contract run's, or QA's harness validation) and is otherwise built once, along
// the same production paths as the contract suites:
//   web       NOTESTEAD_WEB_IMAGE, else tests/acceptance/support/webImage.mts (artifact → `web-build import` →
//             podman build; NOTESTEAD_WEB_ARTIFACT selects a real bundle, the default is fixture F3)
//   headless  NOTESTEAD_HEADLESS_IMAGE, else packages/headless/Containerfile built from a clean copy of the repository
//   device    NOTESTEAD_DEVICE_IMAGE, else tests/fixtures/m1-s5/device (the CLI "other device", a fixture)
//   server    the pinned joplin/server tag (upstream/joplin-version.json), never built
// Built images are recorded so the stack's teardown removes them (unless NOTESTEAD_KEEP_IMAGE=1).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanContext, headlessContainerfileRel } from '../contract/support/headless.ts';
import { redactText } from '../support/redact.ts';
import { findRepoRoot, readVersionPin } from '../support/repoRoot.ts';
import { testLabel } from './guard.ts';

export interface StackImages {
	server: string;
	web: string;
	headless: string;
	device: string;
	// images this process built (removed at teardown unless NOTESTEAD_KEEP_IMAGE=1)
	built: string[];
}

export const builtTags = {
	web: 'localhost/notestead-web:stack-test',
	headless: 'localhost/notestead-headless:stack-test',
};

const logged = (logsDir: string, label: string, cmd: string, args: string[], timeoutMs: number): { code: number | null; output: string; log: string } => {
	mkdirSync(logsDir, { recursive: true });
	const started = Date.now();
	const r = spawnSync(cmd, args, { cwd: findRepoRoot(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
	const output = `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}` : ''}`;
	const log = join(logsDir, `${label}.log`);
	writeFileSync(log, redactText(`$ ${cmd} ${args.join(' ')}\n# exit ${r.status} signal ${r.signal} after ${Date.now() - started} ms\n${output}`));
	return { code: r.status, output, log };
};

const buildWeb = (work: string, logsDir: string): string => {
	const root = findRepoRoot();
	const r = logged(logsDir, 'build-web', process.execPath, [join(root, 'tests', 'acceptance', 'support', 'webImage.mts'), join(work, 'web-image'), builtTags.web], 30 * 60_000);
	const line = r.output.split('\n').filter(l => l.startsWith('{')).pop() ?? '';
	let info: { image?: string; error?: string } = {};
	try {
		info = JSON.parse(line) as typeof info;
	} catch {
		// reported below
	}
	if (!info.image) throw new Error(`the web image could not be built (log ${r.log}): ${info.error ?? r.output.slice(-2000)}`);
	return info.image;
};

const buildHeadless = (work: string, logsDir: string): string => {
	const context = join(work, 'headless-context');
	cleanContext(context);
	if (!existsSync(join(context, headlessContainerfileRel))) throw new Error(`missing ${headlessContainerfileRel}: the headless image cannot be built`);
	const r = logged(logsDir, 'build-headless', 'podman', ['build', '-f', join(context, headlessContainerfileRel),
		'--label', `${testLabel}=stack`, '--layer-label', `${testLabel}=stack`, '-t', builtTags.headless, context], 60 * 60_000);
	if (r.code !== 0) throw new Error(`podman build of ${builtTags.headless} failed (log ${r.log}): ${redactText(r.output).slice(-2000)}`);
	return builtTags.headless;
};

const buildDevice = (logsDir: string): string => {
	const { cli } = readVersionPin();
	const tag = `localhost/notestead-test-device:${cli.version}`;
	const dir = join(findRepoRoot(), 'tests', 'fixtures', 'm1-s5', 'device');
	const r = logged(logsDir, 'build-device', 'podman', ['build', '-f', join(dir, 'Containerfile'), '--build-arg', `JOPLIN_CLI_VERSION=${cli.version}`,
		'--label', `${testLabel}=stack`, '--layer-label', `${testLabel}=stack`, '-t', tag, dir], 30 * 60_000);
	if (r.code !== 0) throw new Error(`the device fixture image failed to build (log ${r.log}): ${r.output.slice(-2000)}`);
	return tag;
};

export const resolveImages = (work: string, logsDir: string): StackImages => {
	const pin = readVersionPin();
	const built: string[] = [];
	const pick = (env: string | undefined, build: () => string): string => {
		if (env) return env;
		const image = build();
		built.push(image);
		return image;
	};
	const web = pick(process.env.NOTESTEAD_WEB_IMAGE, () => buildWeb(work, logsDir));
	const headless = pick(process.env.NOTESTEAD_HEADLESS_IMAGE, () => buildHeadless(work, logsDir));
	const device = pick(process.env.NOTESTEAD_DEVICE_IMAGE, () => buildDevice(logsDir));
	return { server: `${pin.server.image}:${pin.server.tag}`, web, headless, device, built };
};

export const removeBuiltImages = (images: StackImages | undefined): void => {
	if (!images || process.env.NOTESTEAD_KEEP_IMAGE === '1') return;
	for (const image of images.built) spawnSync('podman', ['rmi', '-f', image], { encoding: 'utf8' });
	// Dangling build stages only (no tag, no child), and only those carrying the stack label.
	if (images.built.length > 0) spawnSync('podman', ['image', 'prune', '-f', '--filter', `label=${testLabel}=stack`], { encoding: 'utf8' });
};
