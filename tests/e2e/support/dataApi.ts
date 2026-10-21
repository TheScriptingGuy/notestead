// Helpers over the headless Data API fixture (`dataApi`), shared by the E2E specs that compare the web app with REST.
import { expect } from '@playwright/test';
import type { DataApi, DataApiResult } from './fixtures.ts';

export const ok = (r: DataApiResult, what: string): Record<string, unknown> => {
	expect(r.error, `${what}: the Data API probe failed`).toBeUndefined();
	expect(r.status, `${what}: HTTP status`).toBe(200);
	return r.body as Record<string, unknown>;
};

// The named fields of a Data API item (the API adds `type_`, the item's model type).
export const pick = (item: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.map(k => [k, item[k]]));

// Every note with `title`, conflicts included, from the headless Data API (paginated).
export const notesTitled = (dataApi: DataApi, title: string): Record<string, unknown>[] => {
	const found: Record<string, unknown>[] = [];
	for (let page = 1; page <= 50; page++) {
		const body = ok(dataApi.get(`/notes?fields=id,title,is_conflict&limit=100&page=${page}`), 'GET /notes');
		found.push(...(body.items as Record<string, unknown>[]).filter(n => n.title === title));
		if (!body.has_more) return found;
	}
	throw new Error('more than 50 pages of notes');
};
