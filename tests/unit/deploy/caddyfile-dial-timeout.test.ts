// DNS1-S1 (docs/test-plans/DNS-1.md): the static guard for the DNS-1 fix. Go's resolver waits 5 s per nameserver, and
// Caddy's default dial_timeout is 3 s, so one silent first nameserver became a 502. The shared proxy snippet must set
// `transport http { dial_timeout … }` from 6 s (5 s plus at least 1 s) to 15 s (DNS1-AC3's bound for a dead server).
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../support/repoRoot.ts';

const caddyfile = readFileSync(join(findRepoRoot(), 'deploy', 'web', 'Caddyfile'), 'utf8');

// The text of the `{ … }` block that opens at `open` (index of the `{`), braces matched.
const blockAt = (text: string, open: number): string => {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '{') depth++;
		else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
	}
	throw new Error('unbalanced braces');
};

// The block opened by the line the pattern matches: it opens at that line's LAST `{` (a `{$VAR}` placeholder earlier on
// the line is not a block).
const blockAfter = (text: string, pattern: RegExp): string => {
	const m = pattern.exec(text);
	if (!m) throw new Error(`no match for ${String(pattern)}`);
	return blockAt(text, m.index + m[0].lastIndexOf('{'));
};

const seconds = (value: string): number => {
	const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value);
	if (!m) throw new Error(`unsupported duration ${JSON.stringify(value)}`);
	return m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
};

describe('deploy/web/Caddyfile dial timeout (DNS-1)', () => {
	test('dns1-s1 the joplin_server_proxy reverse_proxy sets transport http dial_timeout from 6 s to 15 s', () => {
		const snippet = blockAfter(caddyfile, /^\(joplin_server_proxy\)[ \t]*\{[ \t]*$/m);
		const proxy = blockAfter(snippet, /^[ \t]*reverse_proxy\b[^\n]*\{[ \t]*$/m);
		// Sanity: this is the proxy block (it holds the Host rewrite), so a wrong block fails here and not at `transport`.
		expect(proxy).toContain('header_up Host');
		const transport = /transport[ \t]+http[ \t]*\{/.exec(proxy);
		expect(transport).not.toBeNull();
		const body = blockAt(proxy, (transport as RegExpExecArray).index + (transport as RegExpExecArray)[0].length - 1);
		const timeout = /^[ \t]*dial_timeout[ \t]+(\S+)[ \t]*$/m.exec(body);
		expect(timeout).not.toBeNull();
		const value = seconds((timeout as RegExpExecArray)[1]);
		expect(value).toBeGreaterThanOrEqual(6);
		expect(value).toBeLessThanOrEqual(15);
	});

	test('dns1-s1 both listeners import the snippet: exactly twice (:8080 and :8089)', () => {
		expect(caddyfile.match(/^[ \t]*import[ \t]+joplin_server_proxy\b/gm)?.length).toBe(2);
	});
});
