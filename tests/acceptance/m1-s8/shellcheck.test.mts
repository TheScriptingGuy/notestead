// M1-S8 follow-up (review M1-S6-r1, STATUS "M1-S8: run shellcheck on deploy/web/notestead-web-entrypoint.sh"): every
// shell script this repository ships or runs (tracked, outside docs/, which holds the architect's spike scratch) is clean
// under the pinned shellcheck of `check:workflows` (.github/scripts/pinned-tools.json), at its default severity. A
// `# shellcheck disable=…` directive is allowed only with a written reason on the same line or the comment line above.
// Runs in ci.yml's acceptance step on both architectures. Test plan: docs/test-plans/M1-S8.md §shellcheck.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readPinnedTools, resolveTool } from '../../../.github/scripts/pinnedTools.ts';
import { makeTempDir, removeDir, repoRoot } from '../support/repo.mts';

const minute = 60_000;

const tracked = (): string[] => {
	const r = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.split('\0').filter(f => f !== '');
};

const isShellScript = (file: string): boolean => {
	if (file.startsWith('docs/')) return false;
	if (file.endsWith('.sh')) return true;
	if (/\.(ts|mts|js|mjs|cjs|json|md|ya?ml|lock|txt|html|css|svg|png|ico)$/.test(file)) return false;
	try {
		return /^#!\s*\S*\b(sh|bash|dash|ash)\b/.test(readFileSync(join(repoRoot, file), 'utf8').split('\n', 1)[0]);
	} catch {
		return false;
	}
};

let shellcheck = '';
const temps: string[] = [];

const runShellcheck = (files: string[]): { code: number | null; output: string } => {
	const r = spawnSync(shellcheck, ['--format=gcc', ...files], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * minute });
	return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}` : ''}` };
};

describe('M1-S8 shellcheck: the repository\'s shell scripts are clean under the pinned shellcheck', () => {
	before(async () => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.SHELLCHECK;
		shellcheck = await resolveTool('shellcheck', readPinnedTools().shellcheck, () => undefined, env);
	});
	after(() => temps.forEach(removeDir));

	it('M1-S8-S01 the scripts in scope include the web image entrypoint (the check is not vacuous)', () => {
		const scripts = tracked().filter(isShellScript);
		assert.ok(scripts.includes('deploy/web/notestead-web-entrypoint.sh'), `scripts found: ${JSON.stringify(scripts)}`);
	});

	it('M1-S8-S02 negative control: the pinned shellcheck reports a planted defect (SC2086) and exits non-zero', () => {
		const dir = makeTempDir('m1s8-shellcheck-neg');
		temps.push(dir);
		const file = join(dir, 'planted.sh');
		writeFileSync(file, '#!/bin/sh\n# planted by the M1-S8 shellcheck test\nrm -rf $1\n');
		const r = runShellcheck([file]);
		assert.notEqual(r.code, 0, r.output);
		assert.match(r.output, /SC2086/);
	});

	it('M1-S8-S03 every tracked shell script outside docs/ passes shellcheck at its default severity', { timeout: 3 * minute }, () => {
		const scripts = tracked().filter(isShellScript);
		const r = runShellcheck(scripts);
		assert.equal(r.code, 0, `shellcheck ${scripts.join(' ')} exited ${r.code}:\n${r.output}`);
	});

	it('M1-S8-S04 every shellcheck disable directive carries a written reason', () => {
		const missing: string[] = [];
		for (const file of tracked().filter(isShellScript)) {
			const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
			lines.forEach((line, i) => {
				if (!/#\s*shellcheck\s+disable=/.test(line)) return;
				const sameLine = /disable=[A-Z0-9,]+\s+#\s*\S.{8,}/.test(line);
				const above = i > 0 ? lines[i - 1].trim() : '';
				const lineAbove = above.startsWith('#') && !/shellcheck/.test(above) && above.replace(/^#\s*/, '').length >= 10;
				if (!sameLine && !lineAbove) missing.push(`${file}:${i + 1}: ${line.trim()}`);
			});
		}
		assert.deepEqual(missing, []);
	});
});
