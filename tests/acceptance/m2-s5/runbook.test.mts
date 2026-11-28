// M2-AC16 at file level (docs/test-plans/M2-S5.md, U-AC16-RB-01, requirement R1): the browser part of the rollback runbook exists in
// deploy/web/README.md under "Rolling back the web app". It is ADR-0005 Decision 4 as user steps, and it is what M2-AC16-02 does:
// sync first, redeploy the previous image by its digest, close every tab, delete the site's data, then open the app again, sign in,
// enter the master password and sync. It names what is lost and the extra welcome notebook (plan F5), and links ADR-0005.
// RED until the senior engineer writes it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../support/repo.mts';

const readme = join(repoRoot, 'deploy', 'web', 'README.md');
const headingPattern = /^#{2,3} Rolling back the web app$/m;

// The section: from the heading to the next heading of the same or a higher level (fewer or equal `#`), or the end of the file.
const sectionOf = (text: string): string => {
	const match = headingPattern.exec(text);
	assert.ok(match, 'deploy/web/README.md has no heading matching /^#{2,3} Rolling back the web app$/m (the runbook R1 of docs/test-plans/M2-S5.md)');
	const level = match[0].indexOf(' ');
	const rest = text.slice(match.index + match[0].length);
	const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
	return next ? rest.slice(0, next.index) : rest;
};

// The steps in order: each pattern must match after the previous step's match, and the text of its own list item or paragraph is
// where a step with two requirements is checked.
const steps: { name: string; pattern: RegExp; alsoInSameItem?: RegExp }[] = [
	{ name: 'sync in the web app first', pattern: /\bsync/i },
	{ name: 'the previous image by its digest', pattern: /\bdigest\b/i },
	{ name: 'close the app\'s tabs', pattern: /\bclose\b[\s\S]{0,80}\btabs?\b/i },
	{ name: 'delete or clear the site\'s data', pattern: /(clear|delete).{0,40}site data/i },
	{ name: 'the master password, then sync', pattern: /master password/i, alsoInSameItem: /\bsync/i },
];

// The list item or paragraph that holds `index`.
const itemAt = (section: string, index: number): string => {
	const before = section.slice(0, index);
	const start = Math.max(before.lastIndexOf('\n\n'), before.search(/\n\s*(?:\d+\.|[-*])\s[^\n]*$/));
	const after = section.slice(index);
	const end = after.search(/\n\s*\n|\n\s*(?:\d+\.|[-*])\s/);
	return section.slice(Math.max(start, 0), end < 0 ? section.length : index + end);
};

describe('M2-AC16 the rollback runbook\'s browser steps', () => {
	it('U-AC16-RB-01 deploy/web/README.md has "Rolling back the web app" with the steps in order, what is lost, and the ADR link', () => {
		const section = sectionOf(readFileSync(readme, 'utf8'));
		let from = 0;
		for (const step of steps) {
			const rest = section.slice(from);
			const match = step.pattern.exec(rest);
			assert.ok(match, `the section has no step "${step.name}" (${step.pattern}) after the previous step`);
			const at = from + match.index;
			if (step.alsoInSameItem) assert.match(itemAt(section, at), step.alsoInSameItem, `the step "${step.name}" does not also mention ${step.alsoInSameItem}`);
			from = at + match[0].length;
		}
		for (const [what, pattern] of [['unsynced local edits', /unsynced/i], ['installed plugins', /plugins/i], ['the extra welcome notebook', /welcome/i]] as const) {
			assert.match(section, pattern, `the section does not name what is lost: ${what} (${pattern})`);
		}
		assert.match(section, /\]\([^)]*0005[^)]*\)/, 'the section does not link ADR-0005 (a Markdown link whose target holds 0005)');
	});
});
