// `withTimeout` (tests/support/poll.ts): a promise that never settles, such as a page evaluation in a frame stuck in a navigation (L22),
// is turned into an error after the bound; a promise that settles in time is untouched.
import { describe, expect, test } from '@jest/globals';
import { withTimeout } from '../../support/poll.ts';

describe('withTimeout', () => {
	test('wt-01 a promise that settles in time keeps its value and its rejection', async () => {
		await expect(withTimeout('x', Promise.resolve(7), 1_000)).resolves.toBe(7);
		await expect(withTimeout('x', Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
	});

	test('wt-02 a promise that never settles fails after the bound, naming what', async () => {
		await expect(withTimeout('the evaluation', new Promise<never>(() => undefined), 50)).rejects.toThrow('the evaluation did not answer within 50 ms');
	});
});
