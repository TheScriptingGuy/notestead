// Helpers over the headless Data API fixture (`dataApi`), shared by the E2E specs that compare the web app with REST.
import { expect } from '@playwright/test';
import type { DataApi, DataApiResult } from './fixtures.ts';
import { notesTitled as queryNotesTitled } from './restQueries.ts';
import type { Item, RestGet } from './restQueries.ts';

export const ok = (r: DataApiResult, what: string): Record<string, unknown> => {
	expect(r.error, `${what}: the Data API probe failed`).toBeUndefined();
	expect(r.status, `${what}: HTTP status`).toBe(200);
	return r.body as Record<string, unknown>;
};

// The named fields of a Data API item (the API adds `type_`, the item's model type).
export const pick = (item: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.map(k => [k, item[k]]));

// The fixture's GET as the pure queries of restQueries.ts take it.
export const restGet = (dataApi: DataApi): RestGet => path => dataApi.get(path);

// Every note with `title`, conflict copies included (CLI 3.7.1 hides them unless asked, M2-S2 F1), from the headless Data
// API (paginated); trashed notes only with includeDeleted.
export const notesTitled = (dataApi: DataApi, title: string, opts: { includeDeleted?: boolean } = {}): Item[] => queryNotesTitled(restGet(dataApi), title, opts);
