// M1-AC2 (pin schema) and M1-AC3 (lockfile vs pin) for `corepack yarn check:pin [--pin <file>] [--lockfile <file>]`.
// Test plan: docs/test-plans/M1-S1.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	assertExitNonZero, assertExitZero, assertOutputIncludes, ensureInstalled, fixturesDir, yarnScript,
} from '../support/repo.mts';
import type { RunResult } from '../support/repo.mts';

const story = 'm1-s1';
const minute = 60_000;
const pinDir = join(fixturesDir, 'm1-s1', 'pin');
const lockDir = join(fixturesDir, 'm1-s1', 'lockfile');
const validPin = join(pinDir, 'valid.json');
const validLock = join(lockDir, 'valid.yarn.lock');

let installed = false;
const checkPin = (label: string, args: string[] = []): RunResult => {
	if (!installed) {
		ensureInstalled(story);
		installed = true;
	}
	return yarnScript(story, label, 'check:pin', args, { timeoutMs: 3 * minute });
};

describe('M1-AC2/AC3 positive controls', () => {
	it('M1-S1-T10 valid pin + valid lockfile fixture (forks at their own versions, `joplin-*` decoy) exits 0', { timeout: 4 * minute }, () => {
		assertExitZero(checkPin('T10-valid-fixtures', ['--pin', validPin, '--lockfile', validLock]));
	});

	it('M1-S1-T11 the repository itself passes: `corepack yarn check:pin` with defaults exits 0', { timeout: 4 * minute }, () => {
		assertExitZero(checkPin('T11-repo'));
	});
});

describe('M1-AC2 NEG: each malformed pin exits non-zero naming the field', () => {
	// File name convention: <field.path>--<case>.json. The checker's message must name <field.path>.
	const invalid = readdirSync(join(pinDir, 'invalid')).filter(f => f.endsWith('.json')).sort();

	it('M1-S1-T12 fixture inventory covers every required field and the AC-named defects', () => {
		const fields = new Set(invalid.map(f => f.split('--')[0]));
		for (const f of ['minor', 'web.repo', 'web.branch', 'web.tag', 'web.commit', 'cli.npm', 'cli.version', 'server.image', 'server.tag', 'syncVersion']) {
			assert.ok(fields.has(f), `no malformed fixture for ${f}`);
		}
		for (const f of ['web.commit--short.json', 'cli.version--tilde-range.json', 'cli.version--x-range.json', 'syncVersion--string.json', 'server.tag--missing.json']) {
			assert.ok(invalid.includes(f), `missing AC fixture ${f}`);
		}
	});

	it('M1-S1-T12a fixture sanity: each malformed pin differs from valid.json only in the named field', () => {
		const leaves = (o: unknown, prefix = ''): Map<string, unknown> => {
			const out = new Map<string, unknown>();
			if (o !== null && typeof o === 'object' && !Array.isArray(o)) {
				for (const [k, v] of Object.entries(o)) for (const [p, x] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, x);
			} else out.set(prefix, o);
			return out;
		};
		const valid = leaves(JSON.parse(readFileSync(validPin, 'utf8')));
		for (const file of invalid) {
			const bad = leaves(JSON.parse(readFileSync(join(pinDir, 'invalid', file), 'utf8')));
			const keys = new Set([...valid.keys(), ...bad.keys()]);
			const differing = [...keys].filter(k => !bad.has(k) || !valid.has(k) || bad.get(k) !== valid.get(k));
			assert.deepEqual(differing, [file.split('--')[0]], `${file} must differ from valid.json in exactly its named field`);
		}
	});

	for (const file of invalid) {
		const field = file.split('--')[0];
		it(`M1-S1-T12 ${file} → non-zero, names "${field}"`, { timeout: 4 * minute }, () => {
			const r = checkPin(`T12-${basename(file, '.json')}`, ['--pin', join(pinDir, 'invalid', file), '--lockfile', validLock]);
			assertExitNonZero(r);
			assertOutputIncludes(r, field, `the message must name the field ${field}`);
		});
	}

	it('M1-S1-T13 a pin file that is not valid JSON → non-zero, names the file', { timeout: 4 * minute }, () => {
		const r = checkPin('T13-not-json', ['--pin', join(pinDir, 'not-json.json'), '--lockfile', validLock]);
		assertExitNonZero(r);
		assertOutputIncludes(r, 'not-json.json', 'the message must name the unreadable pin file');
	});
});

describe('M1-AC3 NEG: the lockfile must resolve `joplin` to cli.version and lockstep @joplin/* to the pin minor', () => {
	const negative = (id: string, lock: string, mustName: (string | RegExp)[]): void => {
		it(`${id} ${lock} → non-zero, names ${mustName.map(String).join(' and ')}`, { timeout: 4 * minute }, () => {
			const r = checkPin(`${id.split(' ')[0]}-${basename(lock, '.yarn.lock')}`, ['--pin', validPin, '--lockfile', join(lockDir, lock)]);
			assertExitNonZero(r);
			for (const needle of mustName) assertOutputIncludes(r, needle, `the lockfile error must name ${String(needle)}`);
		});
	};

	// The AC's own negative control.
	negative('M1-S1-T21', 'joplin-lib-3.8.0.yarn.lock', ['@joplin/lib', '3.8.0']);
	// "every @joplin/* package", not just @joplin/lib.
	negative('M1-S1-T22', 'joplin-utils-3.6.4.yarn.lock', ['@joplin/utils', '3.6.4']);
	// `joplin` must equal cli.version exactly (a later patch in the same minor is still wrong).
	negative('M1-S1-T23', 'joplin-cli-3.7.2.yarn.lock', ['3.7.2']);
	// No `joplin` entry at all: the CLI is not pinned by the lockfile. Must name the bare package `joplin`
	// (not `@joplin/…` and not `joplin-…`).
	negative('M1-S1-T24', 'joplin-cli-absent.yarn.lock', [/(^|[^@\w/-])joplin(?![\w/-])/m]);

	it('M1-S1-T25 fixture sanity: each NEG lockfile differs from the valid one only in its intended entry', () => {
		// Guards the fixtures themselves: a drifted fixture could make T21–T24 fail for the wrong reason.
		const allowed: Record<string, RegExp> = {
			'joplin-lib-3.8.0.yarn.lock': /"@joplin\/lib@npm:3\.(7\.1|8\.0)"|^\s+version: 3\.8\.0$|^\s+checksum:/,
			'joplin-utils-3.6.4.yarn.lock': /"@joplin\/utils@npm:3\.(7\.1|6\.4)"|^\s+version: 3\.6\.4$|^\s+checksum:/,
			'joplin-cli-3.7.2.yarn.lock': /"joplin@npm:3\.7\.[12]"|^\s+version: 3\.7\.2$|^\s+joplin: "npm:3\.7\.[12]"$|^\s+checksum:/,
			'joplin-cli-absent.yarn.lock': /"joplin@npm:3\.7\.1"|^\s+joplin: "npm:3\.7\.1"$|^\s+"@joplin\/(lib|renderer|utils)": "npm:~3\.7"$|^\s+checksum:/,
		};
		const valid = new Set(readFileSync(validLock, 'utf8').split('\n'));
		for (const [file, pattern] of Object.entries(allowed)) {
			const neg = readFileSync(join(lockDir, file), 'utf8').split('\n');
			const negSet = new Set(neg);
			const changed = [...neg.filter(l => !valid.has(l)), ...[...valid].filter(l => !negSet.has(l))];
			assert.ok(changed.length > 0, `${file} is identical to valid.yarn.lock`);
			const unexpected = changed.filter(l => !pattern.test(l));
			assert.deepEqual(unexpected, [], `${file} differs from valid.yarn.lock outside its intended entry`);
		}
	});
});
