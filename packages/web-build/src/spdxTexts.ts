// Standard SPDX licence texts for third-party-notices.txt (ADR-0010 amendment of 2026-10-04, rule 3): offline, pinned
// and reviewed. The source is the npm data package `spdx-license-list` (CC0-1.0, no dependencies), pinned exactly in
// packages/web-build/package.json and yarn.lock and checked by `check:licenses` like any dependency. Its
// `licenses/<SPDX ID>.json` files hold the SPDX License List's plain-text licence texts. Nothing is fetched at build
// time. Placeholders such as `<year> <copyright holders>` are kept as they are.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const spdxTextsPackage = 'spdx-license-list';

export interface StandardTexts {
	// For notices: e.g. "spdx-license-list@6.12.0".
	source: string;
	// The standard text of an SPDX licence ID (case-insensitive), or null when the list has none.
	text: (id: string) => string | null;
}

// Loads the texts installed for the workspace at `webBuildDir` (packages/web-build), resolved like Node would from it.
export const loadStandardTexts = (webBuildDir: string): StandardTexts => {
	const manifestPath = createRequire(join(webBuildDir, 'package.json')).resolve(`${spdxTextsPackage}/package.json`);
	const { version } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
	const licencesDir = join(dirname(manifestPath), 'licenses');
	const files = new Map<string, string>();
	for (const file of readdirSync(licencesDir)) {
		if (file.endsWith('.json')) files.set(file.slice(0, -'.json'.length).toLowerCase(), file);
	}
	const cache = new Map<string, string | null>();
	return {
		source: `${spdxTextsPackage}@${version}`,
		text: id => {
			const key = id.toLowerCase();
			if (!cache.has(key)) {
				const file = files.get(key);
				const data = file ? JSON.parse(readFileSync(join(licencesDir, file), 'utf8')) as { licenseText?: unknown } : null;
				cache.set(key, typeof data?.licenseText === 'string' && data.licenseText.trim() !== '' ? data.licenseText : null);
			}
			return cache.get(key) ?? null;
		},
	};
};
