// Contract globalTeardown: removes every container and network this run labelled, the image under test (unless
// NOTESTEAD_KEEP_IMAGE=1) and the work dir.
import { rmSync } from 'node:fs';
import { podman, removeLabelled } from './podman.ts';
import { webImageTag } from './globalSetup.ts';

const globalTeardown = (): void => {
	if (process.env.NOTESTEAD_CONTRACT_RUN) removeLabelled(process.env.NOTESTEAD_CONTRACT_RUN);
	if (process.env.NOTESTEAD_KEEP_IMAGE !== '1') podman(['rmi', '-f', webImageTag], { allowFail: true });
	if (process.env.NOTESTEAD_CONTRACT_WORK) rmSync(process.env.NOTESTEAD_CONTRACT_WORK, { recursive: true, force: true });
};

export default globalTeardown;
