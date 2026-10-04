// Targeted text edits of the upstream static HTML pages (ADR-0010). The pages are never parsed and re-serialized:
// every byte outside an edited element stays as upstream wrote it, so the CSP <meta> and the <script> tags remain
// byte-identical. Each edit fails when its anchor is missing or ambiguous, so an upstream change breaks the build
// instead of silently shipping upstream branding.

export const escapeHtml = (value: string): string => value
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;')
	.replace(/'/g, '&#39;');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The raw source text of every Content-Security-Policy <meta> element.
export const cspMetas = (html: string): string[] =>
	[...html.matchAll(/<meta\b[^>]*?http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi)].map(m => m[0]);

// Every same-directory reference (`href="./x"`, `src="./x"`, `content="./x"`) of a page, as a bundle path (any
// query string or fragment dropped).
export const localRefs = (html: string): string[] =>
	[...html.matchAll(/\b(?:href|src|content)\s*=\s*"\.\/([^"?#]*)[^"]*"/gi)].map(m => m[1]).filter(p => p !== '');

export const setTitle = (html: string, title: string): string => {
	const pattern = /<title>[\s\S]*?<\/title>/gi;
	const count = [...html.matchAll(pattern)].length;
	if (count !== 1) throw new Error(`expected exactly one <title> element, found ${count}`);
	return html.replace(pattern, () => `<title>${escapeHtml(title)}</title>`);
};

// Inserts `lines` on their own lines just before the line that holds the single closing `tag` (e.g. "</head>").
export const insertBefore = (html: string, tag: string, lines: string[], indent: string): string => {
	const pattern = new RegExp(escapeRegExp(tag), 'gi');
	const matches = [...html.matchAll(pattern)];
	if (matches.length !== 1) throw new Error(`expected exactly one ${tag}, found ${matches.length}`);
	const lineStart = html.lastIndexOf('\n', matches[0].index - 1) + 1;
	const prefix = html.slice(lineStart, matches[0].index).trim() === '' ? lineStart : matches[0].index;
	const block = lines.map(line => `${indent}${line}\n`).join('');
	return html.slice(0, prefix) + block + html.slice(prefix);
};

export interface MetaEdit {
	name?: string;
	property?: string;
	content: string;
}

// Replaces the single <meta name|property="…"> element with one carrying `content`, or adds it before </head>.
export const setMeta = (html: string, edit: MetaEdit, indent: string): string => {
	const attribute = edit.name !== undefined ? 'name' : 'property';
	const value = edit.name ?? edit.property ?? '';
	const tag = `<meta ${attribute}="${escapeHtml(value)}" content="${escapeHtml(edit.content)}"/>`;
	const pattern = new RegExp(`<meta\\b[^>]*\\b${attribute}\\s*=\\s*["']${escapeRegExp(value)}["'][^>]*>`, 'gi');
	const count = [...html.matchAll(pattern)].length;
	if (count > 1) throw new Error(`expected at most one <meta ${attribute}="${value}">, found ${count}`);
	if (count === 1) return html.replace(pattern, () => tag);
	return insertBefore(html, '</head>', [tag], indent);
};
