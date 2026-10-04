// M1-AC7: `corepack yarn workspace web-build verify <dist>` fails if any file's sha256 equals that of an upstream icon
// (upstream:packages/app-mobile/web/public/icons/* at web.commit). NEG: an un-overlaid fixture fails.
// The upstream icon bytes are derived at test time from the pinned commit and never committed.
// Test plan: docs/test-plans/M1-S2.md.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertExitNonZero, assertExitZero, assertOutputIncludes, describeRun, makeTempDir, removeDir } from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';
import { upstreamIcons } from '../support/upstream.mts';
import { attempt, materialize, readTree, settled, upstreamPublicBundle, webBuild, writeTree } from '../support/webBundle.mts';
import type { Attempt, Tree } from '../support/webBundle.mts';

// Extra args for verify: only when the operator set JOPLIN_UPSTREAM_DIR (as for check:no-upstream-copy in M1-S1).
const upstreamArgs = (): string[] => process.env.JOPLIN_UPSTREAM_DIR ? ['--upstream', process.env.JOPLIN_UPSTREAM_DIR] : [];

const verify = (label: string, dir: string): RunResult => webBuild(label, 'verify', [...upstreamArgs(), dir]);

describe('M1-AC7 verify rejects upstream icon hashes', () => {
	const temps: string[] = [];
	let setup: Attempt<{ overlay: RunResult; overlaidTree: Tree }> | null = null;

	// The overlaid F2 bundle (upstream public/ + synthetic webpack outputs, then `overlay`): the positive control.
	before(() => {
		setup = attempt(() => {
			const dir = materialize('m1s2-ac7-overlaid', upstreamPublicBundle());
			temps.push(dir);
			const overlay = webBuild('T70-overlay-F2', 'overlay', [dir]);
			return { overlay, overlaidTree: overlay.code === 0 ? readTree(dir) : new Map<string, Buffer>() };
		});
	});

	after(() => temps.forEach(removeDir));

	// A fresh copy of the overlaid bundle with `planted` files added.
	const overlaidCopy = (label: string, planted: Tree = new Map()): string => {
		const { overlay, overlaidTree } = settled(setup);
		assert.equal(overlay.code, 0, `this test needs an overlaid bundle, but overlay failed. ${describeRun(overlay)}`);
		const dir = materialize(`m1s2-ac7-${label}`, overlaidTree);
		writeTree(dir, planted);
		temps.push(dir);
		return dir;
	};

	it('T70 positive control: the overlaid bundle passes verify', () => {
		assertExitZero(verify('T70-verify-overlaid', overlaidCopy('clean')));
	});

	it('T71 one upstream icon under another name at the root fails, naming that file', () => {
		const icon = upstreamIcons().get('icons/icon-64.png');
		assert.ok(icon, 'upstream icons/icon-64.png missing from the derived set');
		const r = verify('T71-verify-one-planted', overlaidCopy('one-planted', new Map([['favicon-copy.png', icon]])));
		assertExitNonZero(r);
		assertOutputIncludes(r, 'favicon-copy.png', 'verify must name the offending file');
	});

	it('T72 every upstream icon is detected by content, at any depth and under any name', () => {
		const planted: Tree = new Map();
		[...upstreamIcons()].forEach(([path, content], i) => {
			const extension = path.slice(path.lastIndexOf('.'));
			planted.set(`pluginAssets/fixture${i}/nested/asset-${i}${extension}`, content);
		});
		assert.ok(planted.size >= 6, 'expected the full upstream icon set');
		const r = verify('T72-verify-all-planted', overlaidCopy('all-planted', planted));
		assertExitNonZero(r);
		const unnamed = [...planted.keys()].filter(p => !r.output.includes(p));
		assert.deepEqual(unnamed, [], `verify must name every planted upstream icon. ${describeRun(r)}`);
	});

	it('T73 (AC NEG) the un-overlaid bundle fails, naming each upstream icon file', () => {
		const dir = materialize('m1s2-ac7-unoverlaid', upstreamPublicBundle());
		temps.push(dir);
		const r = verify('T73-verify-unoverlaid', dir);
		assertExitNonZero(r);
		const unnamed = [...upstreamIcons().keys()].filter(p => !r.output.includes(p));
		assert.deepEqual(unnamed, [], `verify must name every upstream icon in the un-overlaid bundle. ${describeRun(r)}`);
	});

	it('T74 verify of a missing directory fails and names it (no vacuous pass)', () => {
		const parent = makeTempDir('m1s2-ac7-missing');
		temps.push(parent);
		const missing = join(parent, 'no-such-dist');
		const r = verify('T74-verify-missing-dir', missing);
		assertExitNonZero(r);
		assertOutputIncludes(r, missing, 'verify must name the missing directory');
	});
});
