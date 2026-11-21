// What upstream's app says when its database is newer than the bundle's migration list (docs/test-plans/M2-S5.md F1):
//   upstream:packages/lib/JoplinDatabase.ts (the error) wrapped by upstream:packages/app-mobile/root.tsx's
//   `alert(\`Something went wrong while starting the application: ${error}\`)`. Pure: unit-tested (pr-01…04).
const prefix = 'Something went wrong while starting the application: Error: Unknown profile version. Most likely this is an old version of Joplin, while the profile was created by a newer version.';

export const parseProfileRefusal = (message: string): { profile: number; expected: number } | undefined => {
	if (!message.startsWith(prefix)) return undefined;
	const profile = /^Profile version: (\d+)\s*$/m.exec(message)?.[1];
	const expected = /^Expected version: (\d+)\s*$/m.exec(message)?.[1];
	if (profile === undefined || expected === undefined) return undefined;
	return { profile: Number(profile), expected: Number(expected) };
};
