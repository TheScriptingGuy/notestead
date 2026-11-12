// The cleanup of a fixture's failure path (tests/e2e/support/cleanup.ts cleanupAll; review CI-M2-S2-r3 C1): every cleanup step runs,
// and the error the fixture rethrows is the original one, never a cleanup error that masks it.
import { describe, expect, test } from '@jest/globals';
import { cleanupAll } from '../../e2e/support/cleanup.ts';

describe('fixture cleanup', () => {
	test('clean-01 every step runs, even when an earlier one throws, and the original error is rethrown', async () => {
		const ran: string[] = [];
		const original = new Error('the headless service did not start');
		const steps = [
			async () => { ran.push('logs'); throw new Error('cleanup one failed'); },
			async () => { ran.push('down'); },
			async () => { ran.push('last'); throw new TypeError('cleanup three failed'); },
		];
		await expect(cleanupAll(steps, original)).rejects.toBe(original);
		expect(ran).toEqual(['logs', 'down', 'last']);
	});

	test('clean-02 the cleanup errors are listed on the original, value-free', async () => {
		const original = new Error('the headless service did not start');
		const steps = [
			async () => { throw new Error('token nstsecret0123456789abcdef leaked'); },
			async () => { throw new RangeError('another sekrit'); },
		];
		const thrown = await cleanupAll(steps, original).catch((e: unknown) => e) as Error & { suppressed?: string[] };
		expect(thrown).toBe(original);
		expect(thrown.suppressed).toEqual(['Error', 'RangeError']);
		expect(JSON.stringify(thrown.suppressed)).not.toContain('nstsecret');
		expect(thrown.message).toBe('the headless service did not start');
		// no cleanup error: the original is still rethrown, with nothing listed
		const clean = await cleanupAll([async () => undefined], original).catch((e: unknown) => e) as Error & { suppressed?: string[] };
		expect(clean).toBe(original);
	});
});
