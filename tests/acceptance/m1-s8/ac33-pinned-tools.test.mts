// M1-AC33 (review M1-S3-r1 C4, C5): `pinnedTools` (.github/scripts/pinnedTools.ts, used by `check:workflows`) pins the
// sha256 of each EXTRACTED tool binary in pinned-tools.json and verifies it on every run, cached or freshly downloaded,
// before the binary is ever executed; and each download has a 120 s deadline that fails with the offline hint.
// Unit layer, in process: the module is imported directly (node:test runs it through Node's type stripping, which Jest
// cannot: the module uses import.meta). Seams (docs/test-plans/M1-S8.md §Requirements, M1-AC33): an injected fetch,
// an injected deadline signal (the test controls when the deadline fires: the fake-timer equivalent for
// AbortSignal.timeout, which no mock clock reaches), and the cache dir through XDG_CACHE_HOME in the `env` argument.
// The contract is declared below (PinnedToolsContract), so a missing seam fails each test, not the type check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as pinnedTools from '../../../.github/scripts/pinnedTools.ts';
import { makeTempDir, removeDir, repoRoot } from '../support/repo.mts';

interface FakeResponse {
	ok: boolean;
	status: number;
	arrayBuffer: () => Promise<ArrayBuffer>;
}

type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<FakeResponse>;

interface Asset {
	url: string;
	sha256: string;
	binarySha256?: string;
}

interface Tool {
	version: string;
	member: string;
	assets: Record<string, Asset>;
}

// What M1-AC33 adds to the module (the names are the contract in the test plan).
interface PinnedToolsContract {
	downloadTimeoutMs?: number;
	resolveTool: (
		name: 'actionlint' | 'shellcheck', tool: Tool, log: (line: string) => void, env?: NodeJS.ProcessEnv,
		deps?: { fetch?: FetchLike; deadline?: (ms: number) => AbortSignal },
	) => Promise<string>;
	readPinnedTools: () => Record<'actionlint' | 'shellcheck', Tool>;
	toolsCacheDir: (env?: NodeJS.ProcessEnv) => string;
}

const api = pinnedTools as unknown as PinnedToolsContract;
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const temps: string[] = [];
after(() => temps.forEach(removeDir));

const version = '9.9.9-m1s8';

interface Fixture {
	work: string;
	env: NodeJS.ProcessEnv;
	tarball: Buffer;
	binary: Buffer;
	marker: string;
	tool: Tool;
	bin: string;
	ran: () => boolean;
}

// A fake `actionlint` that prints the pinned version and records every execution in a marker file, packed as a release
// tarball with the binary at `fake/actionlint`.
const fixture = (label: string, opts: { binarySha256?: 'right' | 'wrong' | 'absent' } = {}): Fixture => {
	const work = makeTempDir(`m1s8-ac33-${label}`);
	temps.push(work);
	const marker = join(work, 'executed.log');
	const src = join(work, 'src', 'fake');
	mkdirSync(src, { recursive: true });
	const script = `#!/bin/sh\n# fake actionlint (M1-AC33 test)\necho ran >> '${marker}'\necho '${version}'\n`;
	writeFileSync(join(src, 'actionlint'), script);
	chmodSync(join(src, 'actionlint'), 0o755);
	const tarPath = join(work, 'fake.tar.gz');
	const tar = spawnSync('tar', ['-czf', tarPath, '-C', join(work, 'src'), 'fake/actionlint'], { encoding: 'utf8' });
	assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`);
	const tarball = readFileSync(tarPath);
	const binary = Buffer.from(script);
	const binarySha256 = opts.binarySha256 === 'absent' ? undefined : opts.binarySha256 === 'wrong' ? sha256(Buffer.from('another binary')) : sha256(binary);
	const asset: Asset = { url: 'https://example.invalid/fake.tar.gz', sha256: sha256(tarball), ...(binarySha256 ? { binarySha256 } : {}) };
	const tool: Tool = { version, member: 'fake/actionlint', assets: { [process.arch]: asset } };
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: work, XDG_CACHE_HOME: join(work, 'cache') };
	const bin = join(work, 'cache', 'notestead', 'tools', `actionlint-${version}`, 'actionlint');
	return { work, env, tarball, binary, marker, tool, bin, ran: () => existsSync(marker) };
};

const serving = (tarball: Buffer, calls: { url: string; signal?: AbortSignal }[] = []): FetchLike => async (url, init) => {
	calls.push({ url, signal: init?.signal });
	return { ok: true, status: 200, arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) as ArrayBuffer };
};

const offline: FetchLike = async () => {
	throw new Error('M1-AC33 test: no download expected here');
};

const plantCached = (f: Fixture, content: Buffer): void => {
	mkdirSync(join(f.bin, '..'), { recursive: true });
	writeFileSync(f.bin, content);
	chmodSync(f.bin, 0o755);
};

describe('M1-AC33 pinnedTools verifies the extracted binary and bounds every download', () => {
	it('M1-S8-P01 positive control: a fresh download with matching tarball and binary sha256 resolves, with an abort signal on the fetch', async () => {
		const f = fixture('p01');
		const calls: { url: string; signal?: AbortSignal }[] = [];
		const bin = await api.resolveTool('actionlint', f.tool, () => undefined, f.env, { fetch: serving(f.tarball, calls) });
		assert.equal(bin, f.bin);
		assert.equal(sha256(readFileSync(bin)), sha256(f.binary));
		assert.equal(calls.length, 1, 'one download');
		assert.equal(calls[0].url, f.tool.assets[process.arch].url);
		assert.ok(calls[0].signal instanceof AbortSignal, 'the fetch carries a deadline signal (C5)');
	});

	it('M1-S8-P02 positive control: a cached binary with the pinned sha256 is used without a download', async () => {
		const f = fixture('p02');
		plantCached(f, f.binary);
		const bin = await api.resolveTool('actionlint', f.tool, () => undefined, f.env, { fetch: offline });
		assert.equal(bin, f.bin);
	});

	it('M1-S8-P03 (M1-AC33 NEG) a cached binary that prints the right version but has another sha256 is rejected and never executed', async () => {
		const f = fixture('p03');
		const tampered = Buffer.from(`${f.binary.toString('utf8')}# tampered\n`);
		plantCached(f, tampered);
		await assert.rejects(api.resolveTool('actionlint', f.tool, () => undefined, f.env, { fetch: offline }), (error: Error) => {
			assert.match(error.message, /sha256/i, 'the message names the check');
			assert.ok(error.message.includes(f.bin), `the message names the cached binary ${f.bin}: ${error.message}`);
			return true;
		});
		assert.equal(f.ran(), false, 'the tampered binary was executed (version check before the sha256 check)');
	});

	it('M1-S8-P04 (M1-AC33 NEG) a fresh download whose extracted binary does not match the pinned binary sha256 is rejected, never executed, and not left in the cache', async () => {
		const f = fixture('p04', { binarySha256: 'wrong' });
		await assert.rejects(api.resolveTool('actionlint', f.tool, () => undefined, f.env, { fetch: serving(f.tarball) }), /sha256/i);
		assert.equal(f.ran(), false, 'the mismatching binary was executed');
		assert.equal(existsSync(f.bin), false, 'the mismatching binary was left in the cache, where the next run would find it');
	});

	it('M1-S8-P05 (M1-AC33 NEG) a pin without the binary sha256 fails closed, naming the missing field', async () => {
		const f = fixture('p05', { binarySha256: 'absent' });
		await assert.rejects(api.resolveTool('actionlint', f.tool, () => undefined, f.env, { fetch: serving(f.tarball) }), /binarySha256/);
		assert.equal(f.ran(), false, 'a binary without a pinned sha256 was executed');
	});

	it('M1-S8-P06 (M1-AC33 NEG) a fetch that never resolves fails when the 120 s deadline fires, with the offline hint', { timeout: 30_000 }, async () => {
		const f = fixture('p06');
		const asked: number[] = [];
		const clock = new AbortController();
		let fetched: () => void = () => undefined;
		const fetchStarted = new Promise<void>(resolve => {
			fetched = resolve;
		});
		// Ignores its signal on purpose: the deadline must hold whatever the transport does (a stalled body read too).
		const neverResolves: FetchLike = () => {
			fetched();
			return new Promise<FakeResponse>(() => undefined);
		};
		const pending = api.resolveTool('actionlint', f.tool, () => undefined, f.env, {
			fetch: neverResolves,
			deadline: ms => {
				asked.push(ms);
				return clock.signal;
			},
		});
		pending.catch(() => undefined); // asserted below; avoids an unhandled rejection if the seam is missing
		await Promise.race([fetchStarted, pending.then(() => undefined, () => undefined)]);
		assert.deepEqual(asked, [120_000], 'the download deadline is 120 s, taken from the injected deadline seam');
		clock.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
		await assert.rejects(pending, (error: Error) => {
			assert.match(error.message, /ACTIONLINT=/, 'the offline hint names the override variable');
			assert.match(error.message, /offline/i, 'the offline hint');
			assert.match(error.message, /time(d)? ?out|deadline|120/i, 'the message says the download timed out');
			return true;
		});
		assert.equal(f.ran(), false);
	});

	it('M1-S8-P07 the default deadline constant is 120 s', () => {
		assert.equal(api.downloadTimeoutMs, 120_000, 'pinnedTools exports downloadTimeoutMs = 120_000 (used with AbortSignal.timeout)');
	});
});

describe('M1-AC33 the real pins', () => {
	const pinsFile = join(repoRoot, '.github', 'scripts', 'pinned-tools.json');

	it('M1-S8-P08 pinned-tools.json pins a 64-hex binarySha256 for every tool and architecture, distinct from the tarball sha256', () => {
		const pins = JSON.parse(readFileSync(pinsFile, 'utf8')) as Record<string, Tool | string>;
		const problems: string[] = [];
		for (const [name, tool] of Object.entries(pins)) {
			if (typeof tool === 'string') continue; // the "//" comment
			for (const [arch, asset] of Object.entries(tool.assets)) {
				if (!/^[0-9a-f]{64}$/.test(asset.binarySha256 ?? '')) problems.push(`${name}.assets.${arch}.binarySha256 is ${JSON.stringify(asset.binarySha256)}`);
				else if (asset.binarySha256 === asset.sha256) problems.push(`${name}.assets.${arch}.binarySha256 equals the tarball sha256`);
			}
		}
		assert.deepEqual(problems, []);
	});

	it('M1-S8-P09 on this machine, each pinned tool resolves (cached or downloaded) to a binary whose sha256, computed here, equals its pin', { timeout: 5 * 60_000 }, async () => {
		const pins = api.readPinnedTools();
		for (const name of ['actionlint', 'shellcheck'] as const) {
			const env: NodeJS.ProcessEnv = { ...process.env };
			delete env.ACTIONLINT;
			delete env.SHELLCHECK;
			const bin = await api.resolveTool(name, pins[name], () => undefined, env);
			assert.equal(sha256(readFileSync(bin)), pins[name].assets[process.arch]?.binarySha256, `${name} at ${bin}`);
		}
	});
});
