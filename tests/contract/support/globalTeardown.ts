// Contract globalTeardown: removes every container, network and volume this run labelled, the images under test
// (the `web` image of globalSetup and every image a suite built lazily and recorded under <work>/images/, M1-S5)
// unless NOTESTEAD_KEEP_IMAGE=1, then every untagged image carrying the test label (the install stage of a multi-stage
// build, an older build whose tag a rebuild took), and the work dir.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { podman, removeLabelled, testLabel } from './podman.ts';
import { webImageTag } from './globalSetup.ts';

const lazyImages = (work: string | undefined): string[] => {
	if (!work) return [];
	const dir = join(work, 'images');
	if (!existsSync(dir)) return [];
	const images: string[] = [];
	for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
		const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { image?: string; prebuilt?: boolean };
		if (record.image && !record.prebuilt) images.push(record.image);
	}
	return images;
};

const globalTeardown = (): void => {
	if (process.env.NOTESTEAD_CONTRACT_RUN) removeLabelled(process.env.NOTESTEAD_CONTRACT_RUN);
	if (process.env.NOTESTEAD_KEEP_IMAGE !== '1') {
		for (const image of [webImageTag, ...lazyImages(process.env.NOTESTEAD_CONTRACT_WORK)]) podman(['rmi', '-f', image], { allowFail: true });
		// Dangling images only (no tag, no child): never a tagged image, never one without the label.
		podman(['image', 'prune', '-f', '--filter', `label=${testLabel}=contract`], { allowFail: true });
	}
	if (process.env.NOTESTEAD_CONTRACT_WORK) rmSync(process.env.NOTESTEAD_CONTRACT_WORK, { recursive: true, force: true });
};

export default globalTeardown;
