import { localRefs } from './html.ts';
import { renderSourceOffer } from './sourceOffer.ts';
import type { SourceOfferInput } from './sourceOffer.ts';
import { pinFor } from './testing/fixtures.ts';

const upstreamCommit = 'a'.repeat(40);
const ourCommit = 'b'.repeat(40);

const input = (overrides: Partial<SourceOfferInput> = {}): SourceOfferInput => ({
	pin: pinFor('https://github.com/upstream/app.git', upstreamCommit, 'v3.7.21'),
	ourRepo: 'https://github.com/us/notestead',
	ourCommit,
	ourDirty: false,
	licenseFiles: ['app.bundle.js.LICENSE.txt', 'chunks/1.bundle.js.LICENSE.txt'],
	...overrides,
});

const hrefs = (html: string): string[] => [...html.matchAll(/\bhref="([^"]*)"/g)].map(m => m[1]);

describe('sourceOffer', () => {
	test('links both repositories at their exact commits, the recipe, both licences and the AGPL text', () => {
		const html = renderSourceOffer(input());
		expect(hrefs(html)).toEqual(expect.arrayContaining([
			'https://github.com/upstream/app',
			`https://github.com/upstream/app/tree/${upstreamCommit}`,
			`https://github.com/upstream/app/blob/${upstreamCommit}/LICENSE`,
			'https://github.com/us/notestead',
			`https://github.com/us/notestead/tree/${ourCommit}`,
			`https://github.com/us/notestead/tree/${ourCommit}/packages/web-build`,
			`https://github.com/us/notestead/blob/${ourCommit}/LICENSE`,
			'https://www.gnu.org/licenses/agpl-3.0.html',
		]));
		expect(html).toContain('v3.7.21');
		expect(html).toContain('SKIP_ONENOTE_CONVERTER_BUILD=1 corepack yarn install');
		expect(html).toContain('not affiliated');
		expect(localRefs(html)).toEqual(['app.bundle.js.LICENSE.txt', 'chunks/1.bundle.js.LICENSE.txt']);
	});

	test('states a development build only when our working tree is dirty', () => {
		expect(renderSourceOffer(input())).not.toContain('Development build');
		expect(renderSourceOffer(input({ ourDirty: true }))).toContain('<strong>Development build:</strong> built from this commit plus uncommitted local changes');
	});

	test('says so when webpack emitted no licence files', () => {
		const html = renderSourceOffer(input({ licenseFiles: [] }));
		expect(html).toContain('<li>webpack emitted no licence files for this build.</li>');
		expect(localRefs(html)).toEqual([]);
	});

	test('escapes every value taken from the pin and the repository', () => {
		const html = renderSourceOffer(input({
			pin: pinFor('https://example.org/"><script>alert(1)</script>.git', upstreamCommit, 'v1<b>'),
			ourRepo: 'https://example.org/us?a=1&b=2',
		}));
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<b>');
		expect(html).toContain('https://example.org/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('v1&lt;b&gt;');
		expect(html).toContain('https://example.org/us?a=1&amp;b=2');
	});

	test('links third-party-notices.txt next to the webpack extracts only when the bundle has it', () => {
		expect(localRefs(renderSourceOffer(input({ thirdPartyNotices: true })))).toEqual(['third-party-notices.txt', 'app.bundle.js.LICENSE.txt', 'chunks/1.bundle.js.LICENSE.txt']);
		expect(renderSourceOffer(input({ thirdPartyNotices: false }))).not.toContain('third-party-notices.txt');
	});
});
