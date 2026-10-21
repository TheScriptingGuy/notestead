// Queries over the headless REST Data API for data-level assertions (docs/test-plans/M2-S2.md F1). Pure: they take the
// `get` of the dataApi fixture and import nothing from Playwright, so the unit layer tests them.
export interface RestResult { status?: number; body?: unknown; error?: string }
export type RestGet = (path: string) => RestResult;
export type Item = Record<string, unknown>;

export const withQuery = (path: string, query: string): string => `${path}${path.includes('?') ? '&' : '?'}${query}`;

// Every item of a paginated list, 100 per page. A failed request throws the method, the path with its query and the
// error or the HTTP status; never the response body.
export const allItems = (get: RestGet, path: string, fields: string, maxPages = 50): Item[] => {
	const found: Item[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const full = withQuery(path, `fields=${fields}&limit=100&page=${page}`);
		const r = get(full);
		if (r.error !== undefined) throw new Error(`GET ${full}: ${r.error}`);
		if (r.status !== 200) throw new Error(`GET ${full}: HTTP ${String(r.status)}`);
		const body = r.body as { items?: Item[]; has_more?: boolean };
		found.push(...(body.items ?? []));
		if (!body.has_more) return found;
	}
	throw new Error(`GET ${path}: more than ${maxPages} pages`);
};

// Every note titled `title`, conflict copies included (CLI 3.7.1 leaves them out of GET /notes unless asked: F1);
// trashed notes only with includeDeleted.
export const notesTitled = (get: RestGet, title: string, opts: { includeDeleted?: boolean } = {}): Item[] =>
	allItems(get, `/notes?include_conflicts=1${opts.includeDeleted ? '&include_deleted=1' : ''}`, 'id,title,is_conflict,deleted_time').filter(n => n.title === title);

export const foldersTitled = (get: RestGet, title: string): Item[] => allItems(get, '/folders', 'id,title,parent_id').filter(f => f.title === title);

export const tagsTitled = (get: RestGet, title: string): Item[] => allItems(get, '/tags', 'id,title').filter(t => t.title === title);

export const tagNoteIds = (get: RestGet, tagId: string): string[] => allItems(get, `/tags/${tagId}/notes`, 'id').map(n => String(n.id)).sort();

export const noteTagTitles = (get: RestGet, noteId: string): string[] => allItems(get, `/notes/${noteId}/tags`, 'id,title').map(t => String(t.title)).sort();
