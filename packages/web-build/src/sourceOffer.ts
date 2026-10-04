// source.html: the AGPL-3.0 §13 offer of Corresponding Source for the served web app (ADR-0010). It names the
// upstream repository and exact commit, our repository and exact commit, the build recipe and both licences.
import { escapeHtml } from './html.ts';
import type { Pin } from './pin.ts';

export interface SourceOfferInput {
	pin: Pin;
	ourRepo: string;
	ourCommit: string;
	ourDirty: boolean;
	// Bundle paths of webpack's extracted licence comments (`*.LICENSE.txt`), linked as third-party notices.
	licenseFiles: string[];
}

export const productName = 'Notestead for Joplin (unofficial)';

const link = (href: string, text: string): string => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;

export const renderSourceOffer = (input: SourceOfferInput): string => {
	const { web } = input.pin;
	const upstreamRepo = web.repo.replace(/\.git$/, '');
	const upstreamTree = `${upstreamRepo}/tree/${web.commit}`;
	const ourTree = `${input.ourRepo}/tree/${input.ourCommit}`;
	const notices = input.licenseFiles.length === 0
		? '<li>webpack emitted no licence files for this build.</li>'
		: input.licenseFiles.map(path => `<li>${link(`./${path}`, path)}</li>`).join('\n\t\t\t\t');
	const dirtyNote = input.ourDirty
		? '\n\t\t\t<p><strong>Development build:</strong> built from this commit plus uncommitted local changes, so the commit alone is not its complete source.</p>'
		: '';

	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8"/>
		<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
		<meta name="robots" content="noindex"/>
		<title>Source code - ${escapeHtml(productName)}</title>
		<style>
			body { font: 16px/1.5 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
			code { overflow-wrap: anywhere; }
		</style>
	</head>
	<body>
		<main>
			<h1>Source code of ${escapeHtml(productName)}</h1>
			<p>
				This web app is the web build of the Joplin mobile app, built unmodified from the upstream source below.
				Only static branding files were replaced after the build. It is free software under the
				GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later). You can get the complete
				corresponding source code of the version you are using here:
			</p>
			<h2>Upstream Joplin</h2>
			<ul>
				<li>Repository: ${link(upstreamRepo, upstreamRepo)}</li>
				<li>Exact commit (${escapeHtml(web.tag)}): ${link(upstreamTree, web.commit)}</li>
				<li>Build recipe: <code>SKIP_ONENOTE_CONVERTER_BUILD=1 corepack yarn install</code>, then <code>yarn web</code> in <code>packages/app-mobile</code></li>
				<li>Licence: ${link(`${upstreamRepo}/blob/${web.commit}/LICENSE`, 'AGPL-3.0-or-later')}</li>
			</ul>
			<h2>Notestead (build scripts and branding overlay)</h2>
			<ul>
				<li>Repository: ${link(input.ourRepo, input.ourRepo)}</li>
				<li>Exact commit: ${link(ourTree, input.ourCommit)}</li>
				<li>Build and overlay scripts: ${link(`${ourTree}/packages/web-build`, 'packages/web-build')}</li>
				<li>Licence: ${link(`${input.ourRepo}/blob/${input.ourCommit}/LICENSE`, 'AGPL-3.0-or-later')}</li>
			</ul>${dirtyNote}
			<h2>Licences</h2>
			<ul>
				<li>${link('https://www.gnu.org/licenses/agpl-3.0.html', 'GNU Affero General Public License v3.0 (AGPL-3.0)')}</li>
			</ul>
			<p>Third-party licence notices extracted by webpack:</p>
			<ul>
				${notices}
			</ul>
			<h2>Trademark</h2>
			<p>
				Joplin is a registered trademark of JOPLIN SAS. Notestead is an unofficial project and is not affiliated
				with or endorsed by JOPLIN SAS.
			</p>
			<p>${link('./', 'Back to the app')}</p>
		</main>
	</body>
</html>
`;
};
