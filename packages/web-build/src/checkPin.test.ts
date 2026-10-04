import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkHeadlessManifest, runCheckPin } from './checkPin.ts';
import { pinFor, removeTempDirs, repoRoot, tempDir } from './testing/fixtures.ts';

const pin = pinFor('https://example.org/upstream.git', 'a'.repeat(40));

const manifest = (content: unknown): string => {
	const path = join(tempDir('manifest'), 'package.json');
	writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
	return path;
};

describe('checkPin', () => {
	afterAll(removeTempDirs);

	test('accepts a headless manifest that depends on the CLI at exactly cli.version', () => {
		expect(checkHeadlessManifest(manifest({ dependencies: { joplin: '3.7.1' } }), pin)).toEqual([]);
	});

	test.each([
		[{ dependencies: { joplin: '^3.7.1' } }, 'is "^3.7.1"'],
		[{ dependencies: { joplin: '~3.7.1' } }, 'is "~3.7.1"'],
		[{ dependencies: { joplin: '3.7.0' } }, 'is "3.7.0"'],
		[{ dependencies: { lodash: '4.17.21' } }, 'is missing'],
		[{}, 'is missing'],
	])('rejects %j, naming the manifest and dependencies.joplin', (content, found) => {
		const path = manifest(content);
		expect(checkHeadlessManifest(path, pin)).toEqual([`${path}: dependencies.joplin ${found}, expected exactly "3.7.1" (cli.version; no range)`]);
	});

	test('names an unreadable manifest', () => {
		const path = manifest('{ not json');
		expect(checkHeadlessManifest(path, pin)).toEqual([expect.stringMatching(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: cannot read dependencies\\.joplin`))]);
	});

	test('the repository passes, and a bad --headless-manifest fails with exit 1', () => {
		const lines: string[] = [];
		const out = { info: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
		expect(runCheckPin([], repoRoot, out)).toBe(0);
		const bad = manifest({ dependencies: { joplin: '^3.7.1' } });
		expect(runCheckPin(['--headless-manifest', bad], repoRoot, out)).toBe(1);
		expect(lines).toContain(`  - ${bad}: dependencies.joplin is "^3.7.1", expected exactly "3.7.1" (cli.version; no range)`);
		expect(runCheckPin(['--headless-manifest'], repoRoot, out)).toBe(2);
	});
});
