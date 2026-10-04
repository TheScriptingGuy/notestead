// Shared fixtures for the web-build Jest tests: a small upstream-like `public/` tree written from scratch (no
// upstream content), local git repositories served over file:// and temp-dir bookkeeping.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Pin } from '../pin.ts';
import { git } from '../upstreamCopy.ts';

export const repoRoot = join(__dirname, '..', '..', '..', '..');
export const webBuildDir = join(repoRoot, 'packages', 'web-build');

const temps: string[] = [];

export const tempDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), `web-build-${prefix}-`));
	temps.push(dir);
	return dir;
};

export const removeTempDirs = (): void => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export const writeFiles = (root: string, files: Record<string, string | Buffer>): void => {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
};

export const csp = '<meta\n\t\t\thttp-equiv="Content-Security-Policy"\n\t\t\tcontent="\n\t\t\t\tdefault-src \'self\' ;\n\t\t\t"\n\t\t/>';

const page = (title: string, extraHead = ''): string => [
	'<!DOCTYPE html>', '<html>', '\t<head>', '\t\t<meta charset="utf-8"/>', extraHead,
	'\t\t<link rel="icon" href="./icons/icon-vector-large.svg"/>',
	`\t\t<title>${title}</title>`, '\t\t<script src="./environment.js"></script>', '\t</head>',
	'\t<body><div id="root"></div>', '\t</body>', '\t<script defer src="./app.bundle.js"></script>', '</html>', '',
].join('\n');

// The static files that the upstream recipe copies into dist/, in our own words.
export const publicFiles = (): Record<string, string> => ({
	'index.html': page('Fixture App', `\t\t${csp}\n\t\t<meta name="description" content="Fixture description"/>`),
	'closed.html': page('Closed - Fixture App'),
	'just-one-client.html': page('Error - Fixture App'),
	'environment.js': 'window.__DEV__ = location.origin.includes("localhost");\n',
	'manifest.json': `${JSON.stringify({ name: 'Fixture App', short_name: 'Fixture', start_url: './', display: 'standalone', screenshots: [{ src: './screenshots/a.png' }] })}\n`,
	'icons/icon-vector-large.svg': '<svg>fixture icon</svg>\n',
	'icons/icon-64.png': 'fixture icon 64\n',
	'screenshots/a.png': 'fixture screenshot\n',
});

// Stand-ins for the webpack outputs of `yarn web`.
export const webpackFiles = (): Record<string, string> => ({
	'app.bundle.js': '/* fixture bundle */\n',
	'app.bundle.js.LICENSE.txt': '/*! fixture licence (MIT) */\n',
});

export const distFixture = (): string => {
	const dist = tempDir('dist');
	writeFiles(dist, { ...publicFiles(), ...webpackFiles() });
	return dist;
};

// A local repository whose single commit holds `files`; fetchable by commit SHA over file://.
export const gitRepo = (files: Record<string, string | Buffer>): { dir: string; url: string; commit: string } => {
	const dir = tempDir('repo');
	git(dir, ['init', '--quiet']);
	writeFiles(dir, files);
	git(dir, ['add', '--all']);
	git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
	git(dir, ['config', 'uploadpack.allowFilter', 'true']);
	git(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
	return { dir, url: `file://${dir}`, commit: git(dir, ['rev-parse', 'HEAD']).toString().trim() };
};

// An upstream-like repository with the public files under packages/app-mobile/web/public.
export const upstreamRepo = (): { dir: string; url: string; commit: string } => {
	const files: Record<string, string> = { 'package.json': '{ "private": true }\n', '.gitignore': 'node_modules/\ndist/\n' };
	for (const [path, content] of Object.entries(publicFiles())) files[`packages/app-mobile/web/public/${path}`] = content;
	return gitRepo(files);
};

export const pinFor = (repo: string, commit: string, tag = 'v9.9.9'): Pin => ({
	minor: '3.7',
	web: { repo, branch: 'release-3.7', tag, commit },
	cli: { npm: 'joplin', version: '3.7.1' },
	server: { image: 'docker.io/joplin/server', tag: '3.7.2' },
	syncVersion: 3,
});
