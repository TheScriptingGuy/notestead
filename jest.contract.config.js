// Jest for the contract layer (ADR-0007; docs/testing/strategy.md §2): real containers under podman, real HTTP.
// Separate from jest.config.js so `corepack yarn test` stays fast and container-free. One file at a time, one worker
// (the Pi's one-heavy-job rule). Run: corepack yarn jest -c jest.contract.config.js [tests/contract/<story>]
// globalSetup builds the `web` image under test once (packaged artifact → `web-build import` → podman build, M1-AC28)
// and globalTeardown removes every container, network and image the run labelled.
import base from './jest.config.js';

/** @type {import('jest').Config} */
const config = {
	...base,
	testMatch: ['<rootDir>/tests/contract/**/*.test.ts'],
	testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/fixtures/'],
	maxWorkers: 1,
	testTimeout: 5 * 60_000,
	globalSetup: '<rootDir>/tests/contract/support/globalSetup.ts',
	globalTeardown: '<rootDir>/tests/contract/support/globalTeardown.ts',
};

export default config;
