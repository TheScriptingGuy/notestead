// The branding constants and checkers of the M2-S6 tests (docs/test-plans/M2-S6.md D5 and the AC table). Shared by Jest
// (CommonJS), Playwright and node:test (ESM, erasable TypeScript): no __dirname, no import.meta.
// The constants are the spec. They are never read from packages/web-build/overlay.json: a test that reads its expectation from
// the file it checks proves nothing.

export const productName = 'Notestead for Joplin (unofficial)';
export const productShortName = 'Notestead';
// The notice every page's description carries: both patterns must match one description.
export const notAffiliated: RegExp[] = [/not affiliated/i, /JOPLIN SAS/];

const defaultRepo = 'https://github.com/TheScriptingGuy/notestead';

// Our repository URL, without a trailing "/" or ".git"; NOTESTEAD_SOURCE_REPO is the production override.
export const ourRepoUrl = (env: Record<string, string | undefined> = process.env): string => {
	const configured = env.NOTESTEAD_SOURCE_REPO?.trim();
	return (configured || defaultRepo).replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
};

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

const decodeEntities = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
	if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
	if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
	return entities[name.toLowerCase()] ?? whole;
});

// Every <title> text, entity-decoded and trimmed, in document order.
export const titleOf = (html: string): string[] =>
	[...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)].map(m => decodeEntities(m[1]).trim());

interface Tag { name: string; attrs: Map<string, string> }

// Every <meta> and <link> tag with its attributes (names lowercased, values entity-decoded), in document order. A tag may span
// lines and its quoted values may contain ">".
const headTags = (html: string): Tag[] => {
	const tags: Tag[] = [];
	for (const m of html.matchAll(/<(meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
		const attrs = new Map<string, string>();
		for (const a of m[2].matchAll(/([^\s=/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
			attrs.set(a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
		}
		tags.push({ name: m[1].toLowerCase(), attrs });
	}
	return tags;
};

// The `content` of every <meta> whose `name=` or `property=` is `key`.
export const metaContents = (html: string, key: string): string[] =>
	headTags(html).filter(t => t.name === 'meta' && (t.attrs.get('name') === key || t.attrs.get('property') === key)).map(t => t.attrs.get('content') ?? '');

export interface IconRef { rel: string; href: string }

const iconRelTokens = new Set(['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed']);

// Every icon a page declares, in document order, with the href as written (the caller resolves it against the page URL): a <link>
// whose rel token list has `icon` or `apple-touch-icon` ("shortcut icon" included), and <meta property="og:image">.
export const iconRefs = (html: string): IconRef[] => {
	const refs: IconRef[] = [];
	for (const t of headTags(html)) {
		if (t.name === 'link') {
			const rel = t.attrs.get('rel') ?? '';
			const href = t.attrs.get('href');
			if (href !== undefined && rel.toLowerCase().split(/\s+/).some(token => iconRelTokens.has(token))) refs.push({ rel, href });
		} else if (t.attrs.get('property') === 'og:image') {
			refs.push({ rel: 'og:image', href: t.attrs.get('content') ?? '' });
		}
	}
	return refs;
};

export interface ManifestIcon { src: string; type: string; sizes: string }

const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});

export const manifestIconRefs = (manifest: unknown): ManifestIcon[] => {
	const icons = asObject(manifest).icons;
	if (!Array.isArray(icons)) return [];
	return icons.map(i => {
		const icon = asObject(i);
		return { src: String(icon.src ?? ''), type: String(icon.type ?? ''), sizes: String(icon.sizes ?? '') };
	});
};

export type BrandedPage = 'index' | 'closed' | 'just-one-client';

const mentionsNotice = (text: string): boolean => notAffiliated.every(p => p.test(text));

// What is wrong with one of the three pages' branding (empty: nothing). The title must be ours and be the only one; "Joplin"
// may appear in it only as part of the product name (or JOPLIN SAS); every description (and og:description on the index page) names
// the product and carries the not-affiliated notice. In-page body text that says "Joplin" is nominative and not checked (ADR-0010).
export const htmlBrandingProblems = (page: BrandedPage, html: string): string[] => {
	const problems: string[] = [];
	const titles = titleOf(html);
	if (titles.length !== 1) {
		problems.push(`${page}: expected exactly one <title>, found ${titles.length}: ${JSON.stringify(titles)}`);
	} else {
		const [title] = titles;
		if (!title.includes(productName)) problems.push(`${page}: <title> ${JSON.stringify(title)} does not contain the product name ${JSON.stringify(productName)}`);
		const rest = title.split(productName).join('').split('JOPLIN SAS').join('');
		if (/joplin/i.test(rest)) problems.push(`${page}: <title> ${JSON.stringify(title)} says "Joplin" outside the product name`);
	}
	const keys = page === 'index' ? ['description', 'og:description'] : ['description'];
	for (const key of keys) {
		const contents = metaContents(html, key);
		if (contents.length === 0) problems.push(`${page}: no ${key} meta`);
		for (const content of contents) {
			if (!content.includes(productName)) problems.push(`${page}: ${key} ${JSON.stringify(content)} does not name the product ${JSON.stringify(productName)}`);
			if (!mentionsNotice(content)) problems.push(`${page}: ${key} ${JSON.stringify(content)} lacks the not-affiliated notice (not affiliated ... JOPLIN SAS)`);
		}
	}
	return problems;
};

// What is wrong with the web app manifest: our names, no screenshots (upstream's are its own), and PNG icons of 192x192 and 512x512.
export const manifestBrandingProblems = (json: unknown): string[] => {
	const manifest = asObject(json);
	const problems: string[] = [];
	if (manifest.name !== productName) problems.push(`manifest name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(productName)}`);
	if (manifest.short_name !== productShortName) problems.push(`manifest short_name is ${JSON.stringify(manifest.short_name)}, expected ${JSON.stringify(productShortName)}`);
	if ('screenshots' in manifest) problems.push('manifest still has screenshots (upstream\'s screenshots must be removed)');
	const icons = manifestIconRefs(manifest);
	for (const size of ['192x192', '512x512']) {
		const found = icons.some(i => i.sizes === size && (i.type === 'image/png' || (i.type === '' && i.src.toLowerCase().endsWith('.png'))));
		if (!found) problems.push(`manifest has no PNG icon of ${size}`);
	}
	return problems;
};

export interface HashEntry { path: string; sha256: string }

// The entries whose sha256 is one of `hashes` (sha256 -> the upstream path it belongs to), in the order given.
export const upstreamHashHits = (entries: HashEntry[], hashes: Map<string, string>): { path: string; upstreamPath: string }[] => {
	const hits: { path: string; upstreamPath: string }[] = [];
	for (const e of entries) {
		const upstreamPath = hashes.get(e.sha256);
		if (upstreamPath !== undefined) hits.push({ path: e.path, upstreamPath });
	}
	return hits;
};
