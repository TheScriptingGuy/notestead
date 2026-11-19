// The cleanup of a fixture's failure path (review CI-M2-S2-r3 C1): every step runs even when an earlier one throws, and the error
// that is rethrown is the ORIGINAL one, never a cleanup error that masks it. The cleanup errors are listed on the original as
// `suppressed`, by error name only (their messages can hold secrets or note content). No Playwright import.
export const cleanupAll = async (steps: (() => Promise<void>)[], original: unknown): Promise<never> => {
	const suppressed: string[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			suppressed.push(error instanceof Error ? error.name : typeof error);
		}
	}
	if (suppressed.length > 0 && original !== null && typeof original === 'object') (original as { suppressed?: string[] }).suppressed = suppressed;
	throw original;
};
