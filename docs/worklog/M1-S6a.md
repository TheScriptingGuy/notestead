# Worklog: M1-S6a harness hardening (engineer requirement R1)

- **Agent:** senior-engineer. **Branch:** `feat/M1-S6a-harness-hardening`. **QA commits before mine:** `090c78f` (C2 RED fixtures and test) through `1b7da63` (plan with C1/C4 GREEN).
- **Story:** `docs/test-plans/M1-S6a.md` §Requirements on the implementation, R1 (review `docs/reviews/M1-S6-r1.md` finding C2). C1 and C4 are QA harness code and not part of this worklog. **ADR:** 0007 (no fixed sleeps in tests).
- **Machine:** Raspberry Pi 4 (arm64), Node v24.17.0, ESLint 9.39.4, yarn 4 via corepack. No containers were needed.

## Approach
Only `eslint.config.js` changed (commit `e1910f8`). The "No fixed sleeps in tests (ADR-0007)" block keeps the same files (`testFiles` minus `sleepExempt`; `sleepExempt` is still exactly `tests/support/poll.ts` and `tests/fixtures/**/*.mjs`) and the same message, which now says "setTimeout/setInterval-based delay". Built-in rules only, no custom plugin.

- **`no-restricted-syntax`**: `waitForTimeout` (unchanged), plus the selectors built in `sleepValueSelectors`:
  1. **Any value reference:** `Identifier[name=/^set(Timeout|Interval)$/]`, minus the positions where the identifier is only a name (`timerNamePositions`):
     - a non-computed member property (`req.setTimeout`, `test.setTimeout`, `timeouts.setTimeout`);
     - a non-computed key of an object literal or pattern, a class (`MethodDefinition`, `PropertyDefinition` and their abstract variants), an interface or type literal (`TSPropertySignature`, `TSMethodSignature`);
     - anything inside a type query (`ReturnType<typeof setTimeout>`, `typeof globalThis.setInterval`);
     - an import specifier (left to `no-restricted-imports`, so the report is not doubled);
     - the binding of a shorthand pattern (`const { setInterval } = globalThis`), whose key is reported by selector 2, so the report is not doubled.

     This one selector replaces the old `CallExpression[callee.name="setTimeout"]` selector. It covers calls, arguments (`promisify(setTimeout)`, `new Promise(r => setInterval(r, 10))`), aliases, `setTimeout.bind(…)` and a shorthand object property (`{ setTimeout }`).
  2. **Destructuring** from anything: a pattern key that is the identifier, a string literal or a template literal without substitutions (`{ setTimeout: pause }`, `{ 'setTimeout': p }`, `{ ['setTimeout']: p }`, ``{ [`setInterval`]: p }``).
  3. **Dotted member access on `globalThis|global|window|self`**, including optional chaining and through a TS type assertion (`(globalThis as T).setTimeout`).
  4. **Computed member access with a string key** (literal or substitution-free template).
- **`no-restricted-imports`:** `importNames: ['setTimeout', 'setInterval', 'default']` from `timers`, `node:timers`, `timers/promises`, `node:timers/promises`. ESLint still reports namespace imports, as before.
- **Report position:** every selector reports the node that *names* the timer, never a later call, so an alias or destructuring is reported on the line where the timer is taken (the fixture's `// NEG` line). The C2 run shows exactly one report per NEG fixture, each on its NEG line.

### Beyond the plan's list, deliberately (all in the spirit of R1, none used anywhere in the repository)
- **Computed string keys on any object, not only the four globals** (selector 4). `x['setTimeout']` is not one of R1's allowed positions (those are *non-computed* members), and this also catches `(globalThis as T)['setTimeout']`. The cost is that a test can't write `opts['setTimeout']`; it writes `opts.setTimeout` instead.
- **The default import** of the timers modules (`import timers from 'node:timers'`). It is the whole module object, like the namespace import that was already reported, so `timers.setTimeout(…)` would otherwise slip through as a member on "another object".
- **Class, interface and type-literal keys** and `typeof globalThis.setInterval` are allowed (the plan's hint mentions class and interface keys as an option).
- **Pattern string keys and the TS type-assertion global form** (selectors 2 and 3).

### ADR deviations
None. ADR-0007's ban on setTimeout-based sleeps in tests is now enforced for the value forms as well.

### Upstream-first
Not applicable: no shim, no upstream code involved.

## Commands run and outcomes
All on the Pi (arm64), one lint run at a time. Logs are under `test-results/verify/m1-s6a/` (gitignored), and each ends with `exit <code>`.

| # | Command | Config | Outcome | Log |
|---|---|---|---|---|
| 1 | `node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m1-s6a/c2-lint-sleep-values.test.mts` | first draft | 10 passed, 0 failed, exit 0 | overwritten by run 6 |
| 2 | `node --test --test-concurrency=1 --test-reporter=spec 'tests/acceptance/m1-s6/*.test.mts'` (F1 regression) | first draft | 8 passed, 0 failed, exit 0 | overwritten by run 8 |
| 3 | `corepack yarn lint` | first draft | exit 0 | overwritten by run 7 |
| 4 | `git stash`, then the C2 command of run 1, then `git stash pop` (my own RED check on the committed `1b7da63` config) | HEAD before R1 | **3 passed, 7 failed**, exit 1; the same as QA's `red-c2.log` | `se-red-c2.log` |
| 5 | The C2 command again. Run 4 had overwritten QA's `test-results/acceptance/m1-s6a/C2-lint-sleep-values.log` with the old config's output; this run restores it. | first draft | 10 passed, exit 0 | overwritten by run 6 |
| 6 | The C2 command | final (`e1910f8`) | **10 passed, 0 failed**, exit 0, 33 s | `se-green-c2.log`; lint output in `test-results/acceptance/m1-s6a/C2-lint-sleep-values.log` |
| 7 | `corepack yarn lint` (ESLint, then the three `tsc` projects) on the real tree | final | **exit 0**; nothing printed | `se-lint.log` |
| 8 | The F1 command of run 2 | final | **8 passed, 0 failed**, exit 0, 33 s | `se-f1.log` |
| 9 | `node <scratchpad>/probe.mjs`: ESLint's `Linter` with this block's rules and the TS parser, against 42 one-line cases (26 must be reported, 16 must not) | final | **42/42 as expected**, exit 0 | `se-probe-ts.log`; script copied to `se-probe.mjs` |
| 10 | The same probe with the default espree parser (as for `tests/**/*.js`/`.mjs`) | final | 36/42, exit 1. The 6 misses are **parse errors** on TypeScript-only syntax (`as`, `type`, `interface`, `public`); every JS case is as expected. | `se-probe-espree.log` |

Between runs 1–5 and 6–10, the only changes to `eslint.config.js` were to comments: the header comment now names setInterval, and two long comment lines were rewrapped. All the final evidence (runs 6–10) was taken on the committed file.

`git status` after every acceptance run showed only `eslint.config.js` as modified, so the fixtures were cleaned up. No file under `tests/**` was edited.

**Reports in the C2 lint run** (`C2-lint-sleep-values.log`), one per NEG fixture, all on the `// NEG` line:

| Fixture placed at | Report | Rule |
|---|---|---|
| `tests/unit/__lint_neg_s6a__/sleep-promisify.test.ts` | 6:25 | `no-restricted-syntax` |
| `tests/contract/__lint_neg_s6a__/sleep-alias.test.ts` | 6:15 | `no-restricted-syntax` |
| `tests/e2e/__lint_neg_s6a__/sleep-destructure.spec.ts` | 5:9 | `no-restricted-syntax` |
| `tests/harness/__lint_neg_s6a__/sleep-computed.spec.ts` | 6:42 | `no-restricted-syntax` |
| `packages/headless/src/__lint_neg_s6a__/sleep-interval.test.ts` | 8:32 | `no-restricted-syntax` |
| `tests/acceptance/__lint_neg_s6a__/sleep-interval.test.mts` | 5:10 | `no-restricted-imports` |

## Test evidence (RED → GREEN)
| Test | RED (QA `red-c2.log`; mine `se-red-c2.log`) | GREEN (`se-green-c2.log`) |
|---|---|---|
| `C2-T01` | FAIL | PASS |
| `C2-T02-promisify`, `-alias`, `-destructure`, `-computed`, `-interval`, `-interval-promises` | FAIL (reported lines: none) | PASS |
| `C2-T03-allowed`, `C2-T03-repo`, `C2-T03-only-ban` | PASS | PASS |
| F1 `f1-lint-sleeps.test.mts` (regression) | 8/8 | 8/8 (`se-f1.log`) |
| `corepack yarn lint` on the real tree | exit 0 | exit 0 (`se-lint.log`) |

## Disputes
None. No genuine violation turned up in `tests/**`. The real-tree lint is clean, so existing timer uses stay allowed: `req.setTimeout` in `tests/contract/support/http.ts`, the `node -e 'setInterval(…)'` strings in `tests/contract/m1-s5/headless.test.ts` and `packages/headless/src/cliRunner.test.ts` (string contents, not code), and the exempt `tests/support/poll.ts` and samplers.

## Follow-ups (not in scope)
- **Module-object member access through `require`/`import()`** is still not reported: `require('node:timers').setTimeout(…)` and `(await import('node:timers/promises')).setTimeout(…)`. Destructuring either one *is* reported. A selector on `MemberExpression[object.callee.name="require"]` with a timers-module argument would close the `require` form. Code review remains the backstop, as the review says for ADR-0007.
- **Indirect reads** such as `Reflect.get(globalThis, 'setTimeout')`, or a computed key held in a variable, can't be told from legitimate code by syntax alone. These are accepted.
