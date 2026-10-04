// M1-AC25: `corepack yarn check:no-upstream-copy [--root <dir>]` also fails on any tracked file, whatever its size,
// that carries upstream's licence header together with upstream's copyright line, and names it.
// The upstream header and copyright line are read at test time from upstream:LICENSE at the pinned web.commit and
// never committed here (strategy §4). Test plan: docs/test-plans/M1-S9.md.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, describeRun, ensureInstalled, git, makeTempDir, removeDir, yarnScript,
} from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';
import { upstreamFileAt } from '../support/upstream.mts';
import { attempt, settled } from '../support/webBundle.mts';
import type { Attempt } from '../support/webBundle.mts';

const story = 'm1-s9';
const minute = 60_000;

const upstreamArgs = (): string[] => process.env.JOPLIN_UPSTREAM_DIR ? ['--upstream', process.env.JOPLIN_UPSTREAM_DIR] : [];
const check = (label: string, root: string): RunResult => {
	ensureInstalled(story);
	return yarnScript(story, label, 'check:no-upstream-copy', [...upstreamArgs(), '--root', root], { timeoutMs: 20 * minute });
};

interface UpstreamHeader {
	// Line 1 of upstream:LICENSE (the repository licence statement) and its "Copyright (c) <years> <holder>" line.
	header: string;
	copyright: string;
	holder: string;
}

const readUpstreamHeader = (): UpstreamHeader => {
	const lines = upstreamFileAt('LICENSE').toString('utf8').split(/\r?\n/);
	const header = lines.find(l => l.trim() !== '') ?? '';
	assert.match(header, /AGPL-3\.0-or-later/, 'fixture sanity: line 1 of upstream:LICENSE is the AGPL-3.0-or-later licence statement');
	const copyright = lines.find(l => /^Copyright \(c\) [\d][\d\s,-]*\S/.test(l)) ?? '';
	const m = /^Copyright \(c\) [\d\s,-]+(\S.*)$/.exec(copyright);
	assert.ok(m, 'fixture sanity: upstream:LICENSE has a "Copyright (c) <years> <holder>" line');
	return { header: header.trim(), copyright: copyright.trim(), holder: m[1].trim() };
};

const ourHeader = ['// SPDX-License-Identifier: AGPL-3.0-or-later', '// Copyright (c) 2026 Notestead contributors'];
const body = ['', 'export const notesteadM1S9Fixture = \'a small original file used by the licence-header check\';', ''];

const writeFile = (root: string, rel: string, content: string): void => {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), content);
};

const temps: string[] = [];
after(() => temps.forEach(removeDir));

// A git tree whose `tracked` files are staged (listed by `git ls-files`) and whose `untracked` files are git-ignored.
const makeTree = (prefix: string, tracked: Record<string, string>, untracked: Record<string, string> = {}): string => {
	const root = makeTempDir(`m1s9-${prefix}`);
	temps.push(root);
	git(root, ['init', '--quiet']);
	writeFile(root, '.gitignore', 'node_modules/\n');
	for (const [rel, content] of Object.entries(tracked)) {
		assert.ok(Buffer.byteLength(content) < 1024, `fixture sanity: ${rel} must be smaller than 1 KiB (the hash half of the check ignores it)`);
		writeFile(root, rel, content);
	}
	git(root, ['add', '--all']);
	for (const [rel, content] of Object.entries(untracked)) writeFile(root, rel, content);
	return root;
};

describe('M1-AC25 check:no-upstream-copy flags upstream\'s licence header + copyright line at any size', () => {
	let fixture: Attempt<UpstreamHeader> | null = null;
	before(() => {
		fixture = attempt(readUpstreamHeader);
	});

	// File contents built from upstream:LICENSE at web.commit.
	const files = (): Record<string, string> => {
		const { header, copyright, holder } = settled(fixture);
		const otherYears = `Copyright (c) 2016-2019 ${holder}`;
		assert.notEqual(otherYears, copyright, 'fixture sanity: the year variant differs from the pinned line');
		return {
			// Offending: header + copyright, as a `//` comment block in TypeScript.
			'src/copied-header.ts': [`// ${header}`, '//', `// ${copyright}`, ...body].join('\n'),
			// Offending: the same two lines quoted verbatim in a Markdown file.
			'docs/quoted-header.md': ['# Fixture', '', header, '', copyright, '', 'Original Notestead fixture text.', ''].join('\n'),
			// Offending: an older copy of upstream's header (another year range, same holder) in a `#` comment.
			'scripts/older-years.sh': ['#!/bin/sh', `# ${header}`, `# ${otherYears}`, 'echo notestead-m1-s9-fixture', ''].join('\n'),
			// Clean: our own AGPL header on the same file.
			'src/our-header.ts': [...ourHeader, ...body].join('\n'),
			// Clean: only one of the two parts (the AC requires both together).
			'src/header-only.ts': [`// ${header}`, '// Copyright (c) 2026 Notestead contributors', ...body].join('\n'),
			'docs/copyright-only.md': ['# Third-party credit (fixture)', '', copyright, '', 'Original Notestead fixture text.', ''].join('\n'),
		};
	};
	const offending = ['src/copied-header.ts', 'docs/quoted-header.md', 'scripts/older-years.sh'];
	const clean = ['src/our-header.ts', 'src/header-only.ts', 'docs/copyright-only.md'];

	it('M1-S9-T200 (AC NEG) small tracked files with upstream\'s header and copyright line fail, each named; clean files are not named', { timeout: 21 * minute }, () => {
		const r = check('T200-header-copies', makeTree('header-neg', files()));
		assertExitNonZero(r);
		const unnamed = offending.filter(p => !r.output.includes(p));
		assert.deepEqual(unnamed, [], `every file with upstream's header and copyright line must be named. ${describeRun(r)}`);
		const wronglyNamed = clean.filter(p => r.output.includes(p));
		assert.deepEqual(wronglyNamed, [], `files with our header, or with only one of the two upstream lines, must not be named. ${describeRun(r)}`);
	});

	it('M1-S9-T201 positive control: the same file with our own AGPL header passes (plus one-part files and an ignored, untracked copy)', { timeout: 21 * minute }, () => {
		const f = files();
		const tracked = Object.fromEntries(clean.map(p => [p, f[p]]));
		const r = check('T201-our-header', makeTree('header-pos', tracked, { 'node_modules/fixture-pkg/copied-header.ts': f['src/copied-header.ts'] }));
		assertExitZero(r);
	});
});
