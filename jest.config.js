// Jest runs the unit and integration tests of every workspace (`corepack yarn test`, ADR-0009).
// Sources are ESM TypeScript run by Node's type stripping; under Jest, ts-jest transpiles them to CommonJS
// (no type check here: `corepack yarn lint` runs tsc). The node:test acceptance suite (tests/acceptance/**/*.mts)
// and the fixtures are never collected.

/** @type {import('jest').Config} */
const config = {
	testEnvironment: 'node',
	testMatch: [
		'<rootDir>/packages/*/src/**/*.test.ts',
		'<rootDir>/tests/unit/**/*.test.ts',
		'<rootDir>/tests/integration/**/*.test.ts',
	],
	testPathIgnorePatterns: [
		'/node_modules/',
		'<rootDir>/tests/acceptance/',
		'<rootDir>/tests/fixtures/',
	],
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			tsconfig: {
				target: 'es2023',
				module: 'commonjs',
				moduleResolution: 'node10',
				esModuleInterop: true,
				isolatedModules: true,
				verbatimModuleSyntax: false,
				allowImportingTsExtensions: true,
				noEmit: true,
				types: ['node', 'jest'],
			},
		}],
	},
};

export default config;
