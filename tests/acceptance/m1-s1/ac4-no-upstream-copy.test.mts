// M1-AC4: `corepack yarn check:no-upstream-copy [--root <dir>] [--upstream <git-dir>]` passes on the repo and fails,
// naming the file, on a tree that contains a verbatim copy of upstream:packages/app-mobile/web/serviceWorker.ts.
// The upstream file is fetched at test time from the pinned commit and never committed here.
// Test plan: docs/test-plans/M1-S1.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, describeRun, ensureInstalled, git, makeTempDir, readPin, removeDir,
	upstreamCloneDir, yarnScript,
} from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';

const story = 'm1-s1';
const minute = 60_000;
const upstreamPath = 'packages/app-mobile/web/serviceWorker.ts';
const copiedAs = 'lib/sw-copy.ts';
const ownFile = 'lib/own.ts';

// Passed through only when the operator set it explicitly; otherwise the script obtains the pinned tree itself.
const upstreamArgs = (): string[] => process.env.JOPLIN_UPSTREAM_DIR ? ['--upstream', process.env.JOPLIN_UPSTREAM_DIR] : [];

const check = (label: string, args: string[]): RunResult => {
	ensureInstalled(story);
	return yarnScript(story, label, 'check:no-upstream-copy', [...upstreamArgs(), ...args], { timeoutMs: 20 * minute });
};

// Verbatim bytes of the upstream file at the pinned web.commit.
const fetchUpstreamFile = async (): Promise<Buffer> => {
	const pin = readPin();
	assert.match(pin.web.commit, /^[0-9a-f]{40}$/, 'pin web.commit must be a full SHA to fetch the fixture');
	const clone = upstreamCloneDir();
	if (clone) {
		const r = spawnSync('git', ['-C', clone, 'show', `${pin.web.commit}:${upstreamPath}`], { maxBuffer: 16 * 1024 * 1024 });
		if (r.status === 0 && r.stdout.length > 0) return r.stdout;
	}
	const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?$/.exec(pin.web.repo);
	assert.ok(m, `cannot derive a raw URL from web.repo ${pin.web.repo}; set JOPLIN_UPSTREAM_DIR to a clone containing ${pin.web.commit}`);
	const url = `https://raw.githubusercontent.com/${m[1]}/${pin.web.commit}/${upstreamPath}`;
	const res = await fetch(url);
	assert.equal(res.status, 200, `fetching ${url}`);
	return Buffer.from(await res.arrayBuffer());
};

// Our own text, > 1 KiB, never present upstream.
const ownContent = (): string => {
	const lines = ['// SPDX-License-Identifier: AGPL-3.0-or-later', '// Notestead M1-S1 fixture: original text that must not be flagged.'];
	for (let i = 0; i < 64; i++) lines.push(`export const notesteadFixtureLine${i} = 'line ${i} of an original fixture file';`);
	return `${lines.join('\n')}\n`;
};

const writeFile = (root: string, rel: string, content: string | Buffer): void => {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), content);
};

// A git repo with the given tracked files (staged; `git ls-files` lists them) and optional untracked/ignored ones.
const makeTree = (prefix: string, tracked: Record<string, string | Buffer>, untracked: Record<string, string | Buffer> = {}): string => {
	const root = makeTempDir(prefix);
	git(root, ['init', '--quiet']);
	for (const [rel, content] of Object.entries(tracked)) writeFile(root, rel, content);
	git(root, ['add', '--all']);
	for (const [rel, content] of Object.entries(untracked)) writeFile(root, rel, content);
	return root;
};

describe('M1-AC4 check:no-upstream-copy', () => {
	let upstreamBytes: Buffer | undefined;
	const temps: string[] = [];

	before(async () => {
		upstreamBytes = await fetchUpstreamFile();
		assert.ok(upstreamBytes.length >= 1024, `upstream ${upstreamPath} is only ${upstreamBytes.length} bytes; the check covers files >= 1 KiB`);
	});

	after(() => {
		for (const t of temps) removeDir(t);
	});

	const bytes = (): Buffer => {
		assert.ok(upstreamBytes, 'upstream fixture not available (see before hook failure)');
		return upstreamBytes;
	};

	it('M1-S1-T30 the repository itself passes (`corepack yarn check:no-upstream-copy`)', { timeout: 21 * minute }, () => {
		assertExitZero(check('T30-repo', []));
	});

	it('M1-S1-T31 positive control: a tree with only original files (and an untracked, git-ignored upstream copy) passes', { timeout: 21 * minute }, () => {
		const root = makeTree('m1s1-clean', { [ownFile]: ownContent(), '.gitignore': 'node_modules/\n' }, { 'node_modules/upstream-pkg/serviceWorker.ts': bytes() });
		temps.push(root);
		assertExitZero(check('T31-clean-tree', ['--root', root]));
	});

	it('M1-S1-T32 NEG: a tracked verbatim copy (renamed) of upstream serviceWorker.ts fails, naming the file', { timeout: 21 * minute }, () => {
		const root = makeTree('m1s1-copy', { [ownFile]: ownContent(), [copiedAs]: bytes() });
		temps.push(root);
		const r = check('T32-copied-tree', ['--root', root]);
		assertExitNonZero(r);
		assert.ok(r.output.includes(copiedAs), `the failure must name the copied file ${copiedAs}. ${describeRun(r)}`);
		assert.ok(!r.output.includes(ownFile), `the original file ${ownFile} must not be flagged. ${describeRun(r)}`);
	});
});
