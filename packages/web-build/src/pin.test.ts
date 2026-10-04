import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPinFile, validatePin } from './pin.ts';

const pinFixtures = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'm1-s1', 'pin');
const validPin = (): Record<string, unknown> => JSON.parse(readFileSync(join(pinFixtures, 'valid.json'), 'utf8'));

describe('pin', () => {
	test('accepts the valid fixture and returns the typed pin', () => {
		const { pin, problems } = readPinFile(join(pinFixtures, 'valid.json'));
		expect(problems).toEqual([]);
		expect(pin?.cli.version).toBe('3.7.1');
		expect(pin?.syncVersion).toBe(3);
	});

	test('accepts the repository pin', () => {
		const { problems } = readPinFile(join(__dirname, '..', '..', '..', 'upstream', 'joplin-version.json'));
		expect(problems).toEqual([]);
	});

	// File names encode the expectation: <field.path>--<case>.json must be reported for <field.path> only.
	test.each(readdirSync(join(pinFixtures, 'invalid')).filter(f => f.endsWith('.json')))('rejects %s naming only that field', file => {
		const field = file.split('--')[0];
		const { pin, problems } = readPinFile(join(pinFixtures, 'invalid', file));
		expect(pin).toBeNull();
		expect(problems.map(p => p.split(':')[0])).toEqual([field]);
	});

	test('names the file when it is not JSON', () => {
		const path = join(pinFixtures, 'not-json.json');
		const { pin, problems } = readPinFile(path);
		expect(pin).toBeNull();
		expect(problems).toEqual([expect.stringContaining(`${path}: the pin file is not valid JSON`)]);
	});

	test('names the file when it cannot be read', () => {
		const { problems } = readPinFile(join(pinFixtures, 'does-not-exist.json'));
		expect(problems).toEqual([expect.stringContaining('does-not-exist.json: cannot read the pin file')]);
	});

	test('rejects a pin that is not an object, and sections that are not objects', () => {
		expect(validatePin([]).problems).toEqual(['(root): the pin must be a JSON object']);
		expect(validatePin({ ...validPin(), web: 'v3.7.21' }).problems).toEqual(['web: must be an object, got "v3.7.21"']);
		expect(validatePin({ ...validPin(), cli: undefined }).problems).toEqual(['cli: required object is missing']);
	});

	test('accepts an exact pre-release CLI version but rejects a number-typed version', () => {
		const pin = validPin();
		expect(validatePin({ ...pin, cli: { npm: 'joplin', version: '3.7.2-beta.1' } }).problems).toEqual([]);
		expect(validatePin({ ...pin, cli: { npm: 'joplin', version: 3.7 } }).problems).toEqual(['cli.version: must be a string, got 3.7']);
	});

	test('reports every problem, not only the first', () => {
		const { problems } = validatePin({ ...validPin(), minor: '3', syncVersion: '3', server: {} });
		expect(problems.map(p => p.split(':')[0])).toEqual(['minor', 'server.image', 'server.tag', 'syncVersion']);
	});
});
