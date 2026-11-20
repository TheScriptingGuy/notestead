// M2-S4 HF-1 (docs/test-plans/M2-S4.md, "Planner ruling on the S-NEG1c HARD STOP"): the E2EE device's `joplin batch` syncs twice,
// and the CLI releases the first sync's lock without awaiting it (command-sync.ts:163), so a second plain `sync` in the same
// batch can find the lock held and exit 1 ("Synchronisation is already in progress."). The second sync runs without the local
// lock, which nothing else uses in the device's throwaway profile. The batch is built by `deviceBatch` (device/batch.mjs).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '../support/repo.mts';

interface Plan {
	masterPassword: string;
	folder: string;
	notes: { title: string; body: string }[];
}
interface Extras {
	todo: { title: string; due: number };
	tag: { title: string; note: string };
	attachment: { note: string; fileName: string; contentBase64: string };
}
type DeviceBatch = (plan: Plan, extras: Extras | null, attachmentPath: string) => string;

const { deviceBatch } = await import(pathToFileURL(join(repoRoot, 'tests/fixtures/m1-s5/device/batch.mjs')).href) as { deviceBatch: DeviceBatch };

const plan: Plan = { masterPassword: 'pw', folder: 'F', notes: [{ title: 'N', body: 'B' }] };

describe('M2-S4 HF-1: the E2EE device batch', () => {
	it('DEV-01 the batch syncs twice, the second time without the local lock', () => {
		const lines = deviceBatch(plan, null, '/x').split('\n');
		assert.deepEqual(lines.filter(l => l.startsWith('sync')), ['sync', 'sync --use-lock 0']);
		assert.ok(lines[0].startsWith('e2ee enable --password'), 'the first line enables E2EE');
		assert.equal(lines[lines.length - 1], 'ls --format json');
	});

	it('DEV-02 extras keep their place before the syncs', () => {
		const extras: Extras = { todo: { title: 'T', due: 1 }, tag: { title: 'G', note: 'N' }, attachment: { note: 'A', fileName: 'a.txt', contentBase64: '' } };
		const lines = deviceBatch(plan, extras, '/x/a.txt').split('\n');
		const firstSync = lines.findIndex(l => l.startsWith('sync'));
		assert.ok(firstSync > 0, 'there is a sync');
		const extraLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^(mktodo|tag add|attach)\b/.test(l));
		assert.ok(extraLines.length >= 3, 'the to-do, tag and attachment lines are there');
		for (const { l, i } of extraLines) assert.ok(i < firstSync, `"${l}" comes before the first sync`);
	});
});
