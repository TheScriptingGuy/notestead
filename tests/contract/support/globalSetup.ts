// Contract globalSetup (jest.contract.config.js): removes leftovers of killed runs, then builds the `web` image under
// test once (tests/acceptance/support/webImage.mts: artifact → `web-build import` → podman build). A failure is not
// thrown here: it is recorded in NOTESTEAD_M1S4_WEB_IMAGE so every test fails with the reason (RED names the missing
// pieces instead of aborting the run).
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeLabelled, repoRoot } from './podman.ts';

export const webImageTag = 'localhost/notestead-web:m1-s4-test';

const globalSetup = (): void => {
	const run = `${Date.now().toString(36)}${process.pid.toString(36)}`;
	process.env.NOTESTEAD_CONTRACT_RUN = run;
	removeLabelled();
	const work = mkdtempSync(join(tmpdir(), 'm1s4-contract-'));
	process.env.NOTESTEAD_CONTRACT_WORK = work;
	const r = spawnSync(process.execPath, [join(repoRoot, 'tests', 'acceptance', 'support', 'webImage.mts'), work, webImageTag], {
		cwd: repoRoot, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024,
	});
	const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
	let info: string;
	try {
		JSON.parse(line);
		info = line;
	} catch {
		info = JSON.stringify({ error: `webImage.mts produced no result (exit ${r.status}, signal ${r.signal}): ${(r.stderr ?? '').slice(-2000)}` });
	}
	process.env.NOTESTEAD_M1S4_WEB_IMAGE = info;
};

export default globalSetup;
