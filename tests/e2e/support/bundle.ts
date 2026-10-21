// The web image must serve upstream's app, not the M1-S4 fixture F3 (whose app.bundle.js is a 64 KiB synthetic file).
// Shared by the specs that drive the real app (M1-S7, M2-S1).
import { webRequest } from '../../stack/stack.ts';
import type { StackState } from '../../stack/stack.ts';

export const requireUpstreamBundle = async (stack: StackState, story = 'M1-S7'): Promise<void> => {
	const res = await webRequest(stack, '/app.bundle.js');
	const synthetic = res.text.includes('Notestead M1-S4 synthetic fixture');
	if (res.status !== 200 || synthetic || res.text.length < 1024 * 1024) {
		throw new Error(`${story} needs the upstream web bundle in the web image, but GET /app.bundle.js returned ${res.status}, ${res.text.length} bytes${synthetic ? ', the M1-S4 synthetic fixture F3' : ''}. `
			+ 'Run with NOTESTEAD_WEB_ARTIFACT=<a CI web-bundle artifact dir> (docs/test-plans/M1-S7.md §How to run).');
	}
};
