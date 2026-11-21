// Self-checks of the M2-S6 harness (docs/test-plans/M2-S6.md D2 to D4):
//   H-UO-01  the un-overlaid bundle is reconstructed from the served one plus upstream's public/ at the pin, with no build: every
//            file that is not upstream's is byte-identical to the served one, every public/ file equals upstream's blob, `web-build
//            verify` rejects it, and the image under test serves it (index.html is upstream's byte for byte, no source.html)
//   H-LH-01  an extra web container answers on a localhost origin in a context of its own: secure context, cross-origin isolated,
//            labelled with the run, and gone after `stop`
import { request } from '../../contract/support/http.ts';
import { podmanSync } from '../../stack/stack.ts';
import { roleLabel, runLabel } from '../../stack/guard.ts';
import { requireUpstreamBundle } from '../support/bundle.ts';
import { expect, test } from '../support/fixtures.ts';
import { longSpecTimeoutMs } from '../support/timeouts.ts';
import { checkUnoverlaid } from '../support/unoverlaid.ts';
import { upstreamPublic } from '../support/upstreamBranding.ts';

const portOf = (url: string): number => Number.parseInt(new URL(url).port, 10);

test.describe('M2-S6 harness: un-overlaid bundle and localhost origin', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });

	test('H-UO-01 the reconstructed bundle is exactly upstream\'s yarn web output around the served files, and is served as such', async ({ stack, unoverlaidDist, extraWebs }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		expect(checkUnoverlaid(unoverlaidDist), 'the reconstruction\'s self-check (D2 step 4)').toEqual([]);

		const web = await extraWebs.start({ role: 'web-unoverlaid', mountDist: unoverlaidDist.unoverlaid });
		const port = portOf(web.url);
		const index = await request({ port, path: '/index.html' });
		expect(index.status).toBe(200);
		expect(index.body.equals(upstreamPublic().get('index.html')!), 'the served index.html equals upstream\'s at the pin').toBe(true);
		expect((await request({ port, path: '/source.html' })).status, 'an un-overlaid bundle has no source.html').toBe(404);
		expect((await request({ port, path: '/icons/icon-large.png' })).status, 'upstream\'s large icon is served by the un-overlaid bundle').toBe(200);
	});

	test('H-LH-01 an extra web container answers on a localhost origin, labelled with the run, and is gone after stop', async ({ stack, extraWebs, appContexts }) => {
		await requireUpstreamBundle(stack, 'M2-S6');
		const web = await extraWebs.start({ role: 'web-extra' });
		const port = portOf(web.url);
		const app = await appContexts.open(`http://localhost:${port}`, 'lh');
		const response = await app.page.goto(`http://localhost:${port}/manifest.json`);
		expect(response?.status()).toBe(200);
		const facts = await app.page.evaluate(() => {
			const g = globalThis as unknown as { location: { origin: string }; isSecureContext: boolean; crossOriginIsolated: boolean };
			return { origin: g.location.origin, secure: g.isSecureContext, isolated: g.crossOriginIsolated };
		});
		expect(facts.origin).toContain('localhost');
		expect(facts.secure, 'isSecureContext on http://localhost').toBe(true);
		expect(facts.isolated, 'crossOriginIsolated on http://localhost (COOP and COEP from the image\'s Caddyfile)').toBe(true);

		const labels = JSON.parse(podmanSync(['inspect', '--format', '{{json .Config.Labels}}', web.container]).stdout) as Record<string, string>;
		expect(labels[runLabel]).toBe(stack.run);
		expect(labels[roleLabel]).toBe('web-extra');

		extraWebs.stop(web);
		const left = podmanSync(['ps', '-a', '--filter', `name=^${web.container}$`, '--format', '{{.Names}}']).stdout.trim();
		expect(left, 'the container is gone after stop').toBe('');
	});
});
