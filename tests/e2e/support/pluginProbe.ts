// The synthetic probe plugin (docs/test-plans/M2-S4.md D7), built per test from our own source in
// tests/fixtures/plugins/probe/ with our ustar writer. Never committed as a binary.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../support/repoRoot.ts';
import { ustar } from '../../support/ustar.ts';

export type ProbeKind = 'desktop' | 'mobile';
export interface ProbePlugin { path: string; sha256: string; id: string; name: string; marker: string }

export const buildProbeJpl = (opts: { kind: ProbeKind; run: string; dir: string }): ProbePlugin => {
	const source = join(findRepoRoot(), 'tests', 'fixtures', 'plugins', 'probe');
	const id = `org.notestead.test.probe-${opts.kind}`;
	const name = opts.kind === 'desktop' ? 'Notestead probe (desktop only)' : 'Notestead probe (mobile)';
	const marker = `nst-plugin-probe-${opts.kind}-${opts.run}`;
	const platforms = opts.kind === 'desktop' ? ['desktop'] : ['desktop', 'mobile'];
	const base = JSON.parse(readFileSync(join(source, 'manifest.base.json'), 'utf8')) as Record<string, unknown>;
	const manifest = { manifest_version: base.manifest_version, id, name, ...base, platforms };
	const placeholder = "'__NST_MARKER__'";
	const template = readFileSync(join(source, 'index.js'), 'utf8');
	if (!template.includes(placeholder)) throw new Error('the probe index.js has no marker placeholder');
	const index = template.replace(placeholder, JSON.stringify(marker));
	const archive = ustar([
		{ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, '\t')}\n`, 'utf8') },
		{ name: 'index.js', data: Buffer.from(index, 'utf8') },
	]);
	const path = join(opts.dir, `${id}.jpl`);
	writeFileSync(path, archive);
	return { path, sha256: createHash('sha256').update(archive).digest('hex'), id, name, marker };
};
