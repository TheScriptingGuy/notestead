// ESLint flat config (ADR-0009), modelled on upstream Joplin's eslint.config.js: the same parser and plugins
// (@typescript-eslint, @stylistic, jest) and the same style (tabs, single quotes, semicolons, trailing commas).
// Added for this project's test rules (ADR-0007/0009): no focused or skipped tests (Jest and Playwright) and no fixed
// sleeps (`waitForTimeout`, setTimeout/setInterval used as a value). `corepack yarn lint` runs this config, then
// `tsc --noEmit`.
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import jest from 'eslint-plugin-jest';
import playwright from 'eslint-plugin-playwright';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

const tsFiles = ['**/*.ts', '**/*.mts', '**/*.cts'];
const jestFiles = ['**/*.test.ts', '**/*.test.tsx'];
// Every Playwright spec under tests/, the harness self-tests (tests/harness/selftest/) included.
const playwrightFiles = ['tests/**/*.spec.ts'];
// Test files: everything under tests/ and test files co-located with the code (packages/*/src/*.test.ts).
const testFiles = ['tests/**', '**/*.test.ts', '**/*.test.tsx', '**/*.test.mts', '**/*.spec.ts'];
// Exempt from the setTimeout ban, exactly: the harness's one polling primitive (waitFor) and the programs that run
// inside test containers and sample at an interval (health-watch.mjs, proc-watch.mjs).
const sleepExempt = ['tests/support/poll.ts', 'tests/fixtures/**/*.mjs'];
const noWaitForTimeout = {
	selector: 'CallExpression[callee.property.name="waitForTimeout"]',
	message: 'No fixed sleeps: wait for a condition (expect.poll, waitFor, a readiness probe) instead of waitForTimeout.',
};
const noSleepMessage = 'No fixed sleeps in tests (ADR-0007): wait for a condition with waitFor (tests/support/poll.ts) or expect.poll instead of a setTimeout/setInterval-based delay.';
// `setTimeout` and `setInterval` imported under any name from the timers modules. A namespace import and a default
// import (both the whole module object) are reported too.
const timersModules = ['timers/promises', 'node:timers/promises', 'timers', 'node:timers'];
// The banned timer names (esquery regexes) and the global objects that carry them.
const timerName = '/^set(Timeout|Interval)$/';
const timerGlobal = '/^(globalThis|global|window|self)$/';
// Positions where an identifier spelled setTimeout/setInterval is a name, not a use of the timer: a property after a
// dot (`req.setTimeout`, `test.setTimeout`; the global objects are matched separately), a key of an object literal or
// pattern (patterns are matched separately), of a class or of an interface or type literal, a type query
// (`ReturnType<typeof setTimeout>`), and an import specifier (checked by no-restricted-imports).
const timerNamePositions = [
	'MemberExpression[computed=false] > Identifier.property',
	'Property[computed=false] > Identifier.key',
	'MethodDefinition[computed=false] > Identifier.key',
	'PropertyDefinition[computed=false] > Identifier.key',
	'TSAbstractMethodDefinition[computed=false] > Identifier.key',
	'TSAbstractPropertyDefinition[computed=false] > Identifier.key',
	'TSPropertySignature[computed=false] > Identifier.key',
	'TSMethodSignature[computed=false] > Identifier.key',
	'TSTypeQuery Identifier',
	'ImportSpecifier > Identifier',
	// The binding of a shorthand pattern (`const { setInterval } = globalThis`): its key is reported, once.
	'ObjectPattern > Property[shorthand=true] > Identifier.value',
];
// A string key naming a timer: a string literal ('setTimeout') or a template literal without substitutions.
const timerStringKey = field => [
	`Literal.${field}[value=${timerName}]`,
	`TemplateLiteral.${field}[expressions.length=0][quasis.0.value.cooked=${timerName}]`,
];
// Every form that takes the global setTimeout/setInterval as a value. Each selector reports the node that names the
// timer, so the report sits on the line where the timer is taken, not on a later call of an alias.
const sleepValueSelectors = [
	// Any reference outside the name positions above: a call, an argument (`promisify(setTimeout)`), an alias
	// (`const later = setTimeout`), `setTimeout.bind(…)`, a shorthand property (`{ setTimeout }`).
	`Identifier[name=${timerName}]${timerNamePositions.map(p => `:not(${p})`).join('')}`,
	// Destructuring, under any name and from anything: `const { setTimeout: pause } = globalThis`,
	// `const { setInterval } = require('timers')`.
	`ObjectPattern > Property > Identifier.key[name=${timerName}]`,
	...timerStringKey('key').map(key => `ObjectPattern > Property > ${key}`),
	// Member access on the global objects, dotted (also through a type assertion such as `(globalThis as T).setTimeout`).
	`MemberExpression[computed=false][object.name=${timerGlobal}] > Identifier.property[name=${timerName}]`,
	`MemberExpression[computed=false][object.expression.name=${timerGlobal}] > Identifier.property[name=${timerName}]`,
	// Computed with a string key, on any object: `globalThis['setTimeout']`, `globalThis[`setInterval`]`.
	...timerStringKey('property').map(property => `MemberExpression[computed=true] > ${property}`),
];

export default defineConfig([
	globalIgnores([
		'**/node_modules/',
		'**/dist/',
		'**/build/',
		'coverage/',
		'test-results/',
		'playwright-report/',
		'blob-report/',
		'.yarn/',
		// Architect-owned spike scratch scripts (evidence for docs/spikes/*.md), not project code.
		'docs/',
	]),
	{
		name: 'Base rules (all files)',
		extends: [js.configs.recommended],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: { ...globals.node, ...globals.es2023 },
		},
		linterOptions: {
			reportUnusedDisableDirectives: 'error',
		},
		plugins: {
			'@stylistic': stylistic,
		},
		rules: {
			// Code correctness
			'no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'caughtErrors': 'none' }],
			'prefer-const': 'error',
			'no-var': 'error',
			'no-new-func': 'error',
			'prefer-promise-reject-errors': ['error', { allowEmptyReject: true }],
			'no-throw-literal': 'error',
			'no-unused-expressions': 'error',
			'no-array-constructor': 'error',
			'radix': 'error',
			'eqeqeq': ['error', 'always'],
			'no-console': ['error', { 'allow': ['warn', 'error'] }],
			'no-unneeded-ternary': 'error',
			'prefer-template': 'error',
			'prefer-object-spread': 'error',
			'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
			'prefer-arrow-callback': 'error',
			'no-constant-binary-expression': 'error',
			// Upstream's vocabulary rule: "error", not "err"; "folder" in code, "notebook" in user-facing text.
			'id-denylist': ['error', 'err', 'notebook', 'notebooks'],

			// Formatting
			'@stylistic/indent': ['error', 'tab', { 'ignoredNodes': ['TSUnionType', 'TemplateLiteral *'], 'SwitchCase': 0 }],
			'@stylistic/space-in-parens': ['error', 'never'],
			'@stylistic/space-infix-ops': 'error',
			'curly': ['error', 'multi-line'],
			'@stylistic/semi': ['error', 'always'],
			'@stylistic/eol-last': ['error', 'always'],
			'@stylistic/quotes': ['error', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': 'always' }],
			'@stylistic/comma-dangle': ['error', {
				'arrays': 'always-multiline',
				'objects': 'always-multiline',
				'imports': 'always-multiline',
				'exports': 'always-multiline',
				'functions': 'always-multiline',
				'enums': 'always-multiline',
				'generics': 'ignore',
				'tuples': 'always-multiline',
			}],
			'@stylistic/comma-spacing': ['error', { 'before': false, 'after': true }],
			'@stylistic/no-trailing-spaces': 'error',
			'@stylistic/linebreak-style': ['error', 'unix'],
			'@stylistic/template-curly-spacing': ['error', 'never'],
			'@stylistic/object-curly-spacing': ['error', 'always'],
			'@stylistic/array-bracket-spacing': ['error', 'never'],
			'@stylistic/key-spacing': ['error', { 'beforeColon': false, 'afterColon': true, 'mode': 'strict' }],
			'@stylistic/block-spacing': 'error',
			'@stylistic/brace-style': ['error', '1tbs', { 'allowSingleLine': true }],
			'@stylistic/function-call-spacing': 'error',
			'@stylistic/space-before-function-paren': ['error', { 'anonymous': 'never', 'named': 'never', 'asyncArrow': 'always' }],
			'@stylistic/multiline-comment-style': ['error', 'separate-lines', { checkJSDoc: false }],
			'@stylistic/space-before-blocks': 'error',
			'@stylistic/spaced-comment': ['error', 'always'],
			'@stylistic/keyword-spacing': ['error', { 'before': true, 'after': true }],
			'@stylistic/no-multi-spaces': 'error',
			'@stylistic/arrow-spacing': ['error', { 'before': true, 'after': true }],
		},
	},
	{
		// Files the web-build overlay installs into the web bundle (ADR-0010): classic browser scripts, not modules.
		name: 'Web bundle overlay scripts',
		files: ['packages/web-build/overlay/**/*.js'],
		languageOptions: {
			sourceType: 'script',
			globals: { ...globals.browser },
		},
	},
	{
		name: 'TypeScript',
		files: tsFiles,
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				// Type information for @typescript-eslint/no-floating-promises: each file uses its nearest tsconfig.json.
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			'@typescript-eslint': typescriptEslint,
		},
		rules: {
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'caughtErrors': 'none' }],
			'no-undef': 'off', // tsc reports undefined names, with type information
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/ban-ts-comment': 'error',
			'@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
			'@typescript-eslint/no-unsafe-function-type': 'error',
			'@typescript-eslint/no-wrapper-object-types': 'error',
			'@typescript-eslint/explicit-member-accessibility': 'error',
			'@typescript-eslint/array-type': 'error',
			'@typescript-eslint/no-inferrable-types': 'error',
			'@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
			'@typescript-eslint/no-floating-promises': ['error', {
				// node:test's describe/it return promises that the runner awaits itself.
				allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }],
			}],
			'@typescript-eslint/naming-convention': ['error',
				{ selector: 'enumMember', format: ['StrictPascalCase'] },
				{ selector: 'interface', format: ['StrictPascalCase'] },
			],
			// Colons as upstream (`name: Type`). Arrows in function types are spaced like arrow functions (`() => void`),
			// checked by @stylistic/arrow-spacing.
			'@stylistic/type-annotation-spacing': ['error', { 'before': false, 'after': true, 'overrides': { 'arrow': 'ignore' } }],
			'@stylistic/member-delimiter-style': ['error', {
				'multiline': { 'delimiter': 'semi', 'requireLast': true },
				'singleline': { 'delimiter': 'semi', 'requireLast': false },
			}],
		},
	},
	{
		name: 'Jest tests (packages and tests/)',
		files: jestFiles,
		languageOptions: {
			globals: globals.jest,
		},
		plugins: { jest },
		rules: {
			'jest/no-focused-tests': 'error',
			'jest/no-disabled-tests': 'error',
			'jest/no-identical-title': 'error',
			'jest/require-top-level-describe': ['error', { 'maxNumberOfTopLevelDescribes': 1 }],
			'jest/prefer-lowercase-title': ['error', { 'ignoreTopLevelDescribe': true }],
		},
	},
	{
		name: 'Playwright tests',
		files: playwrightFiles,
		plugins: { playwright },
		rules: {
			'playwright/no-skipped-test': 'error',
			'playwright/no-focused-test': 'error',
		},
	},
	{
		name: 'No fixed sleeps in tests (ADR-0007)',
		files: testFiles,
		ignores: sleepExempt,
		rules: {
			// The global setTimeout/setInterval used as a value in any form (calls, `promisify`, aliases, destructuring,
			// global member access). Deadlines such as `req.setTimeout(ms, cb)` and `test.setTimeout(ms)`, spies
			// (`jest.spyOn(globalThis, 'setTimeout')`), type positions and option keys are not matched.
			'no-restricted-syntax': ['error', noWaitForTimeout, ...sleepValueSelectors.map(selector => ({ selector, message: noSleepMessage }))],
			'no-restricted-imports': ['error', {
				paths: timersModules.map(name => ({ name, importNames: ['setTimeout', 'setInterval', 'default'], message: noSleepMessage })),
			}],
		},
	},
	{
		name: 'No fixed sleeps in tests (ADR-0007): the exempt polling primitive and in-container samplers',
		files: sleepExempt,
		rules: {
			'no-restricted-syntax': ['error', noWaitForTimeout],
		},
	},
]);
