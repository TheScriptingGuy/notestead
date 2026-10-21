# M2-S2 work orders (QA executor)

These orders implement `docs/test-plans/M2-S2.md`. Read that plan first: Planner decisions D1 to D7, Findings F1 to F7 and the AC table are the design. Each order gives the files, signatures, selectors, assertions, the commit split and subjects, the commands and the expected outcome. Upstream paths are under `~/joplin-web-app-work/upstream-joplin/packages/` at `v3.7.21` (read-only).

## Rules for every order
- **Branch:** `feat/M2-S2-notes-notebooks-tags-todos` (already checked out).
- **Commit trailer**, at the end of every message:
  ```
  Agent: qa-specialist
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HDZtZf644tRb9aJyBFPmyj
  ```
  (Use your own model name in `Co-Authored-By` if the orchestrator's dispatch names one.)
- **Commit subjects:** `test(...)`, `chore(...)`, `docs(testing)` or `docs(test-plans)` only. Never `feat`, never `fix` (P-R1), and never push.
- **Test-first history (P2):** an order marked **RED commit** is two commits.
  - The first holds only the failing test, run and logged under `red/`.
  - The second holds the support code, with the test passing, logged under `green/`.

  The RED commit may fail `tsc`, because it imports a module that does not exist yet. Do not add a stub to make it compile.
- **Paths:** write only `tests/**`, `playwright.config.ts`, `docs/testing/**` and `docs/test-plans/M2-S2*.md`. Never write `packages/**`, `deploy/**`, `.github/**`, `eslint.config.js`, `upstream/**`, ADRs or STATUS.
- **Tests:**
  - No `.only`, `.skip`, `fixme`, `waitForTimeout` or sleeps.
  - Wait with `expect.poll`, `waitFor` or `holdsFor` (`tests/support/poll.ts`).
  - Type into the app only with real key events: `typeLikeUser`, `clearLikeUser`, `NoteScreen.typeBody` or `AlarmDialog.enterLocal`. Never `fill()`, never `dispatchEvent`.
  - Never weaken an assertion or change an asserted upstream string. If upstream behaves differently from this plan, stop that order and report: the exact text, a DOM excerpt (`ariaSnapshot()`), and the test's `error-context.md`.
  - If a role locator hits a strict-mode violation because a hidden screen has a twin (plan F7), add `.filter({ visible: true })` to it and record it in your report. Nothing else changes.
- **Pi rules:**
  - Run one heavy job at a time (E2E, contract, full `yarn lint`, image builds), in the background with `timeout`, with one Playwright worker (the local default).
  - Never touch `byparr` or any podman resource without the label `io.github.thescriptingguy.notestead.test`.
  - **Leftover stacks (P1):** if `podman ps -a` shows a test-labelled stack or container you did not start, **do not remove it**. Report its compose project, age and labels to the orchestrator, and wait for the answer.
- **Logs:** every command's output goes under `test-results/verify/m2-s2/<phase>/<name>.log`, where `<phase>` is `red`, `green`, `sens` or `verify`. Use this wrapper:
  ```sh
  cd ~/Joplin-Web-App
  export NOTESTEAD_WEB_ARTIFACT=$HOME/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21
  run() { log=$1; shift; mkdir -p "$(dirname "$log")"; s=$(date +%s); timeout "${T:-100m}" "$@" > "$log" 2>&1; c=$?; echo "# duration $(( $(date +%s) - s )) s; exit $c" >> "$log"; return $c; }
  IMG="NOTESTEAD_WEB_IMAGE=localhost/notestead-web:stack-test NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test NOTESTEAD_DEVICE_IMAGE=localhost/notestead-test-device:3.7.1"
  # heavy example (background):  T=60m run test-results/verify/m2-s2/green/x.log env $IMG corepack yarn playwright test <spec>
  ```
  - **Images:**
    - No test image exists right now; only `byparr`'s images are present.
    - The **first** E2E run builds them. Run it with `NOTESTEAD_KEEP_IMAGE=1` and without `$IMG`.
    - Later runs add `env $IMG`.
    - **After WO-7 changes `device.mjs`**, run once without `NOTESTEAD_DEVICE_IMAGE` (keep the other two) and with `NOTESTEAD_KEEP_IMAGE=1`. That rebuilds the device image under the same tag. `$IMG` is then valid again.
  - **Traces:** never add `--trace on`, and never set `use.trace`. The `webApp` fixture records traces itself (the Node 24 workaround).
- **Light checks after each order:**
  - `corepack yarn eslint --max-warnings 0 <changed files>`;
  - `corepack yarn tsc -p tsconfig.json` (skip it on a RED commit);
  - the full `corepack yarn lint` once, in WO-17.

---

## WO-0: Pre-flight (no commit)
1. Save the podman state:
   ```sh
   mkdir -p test-results/verify/m2-s2
   { podman ps -a; podman network ls; podman volume ls; podman images; } > test-results/verify/m2-s2/podman-before.txt
   ```
   Only `byparr` and its network are expected. Anything else that carries the test label is a leftover stack: report it (P1), don't remove it.
2. `git status` must be clean, and `git log -1 --format=%h` must be the planner's commit on this branch.
3. Check that the bundle dir exists: `ls $NOTESTEAD_WEB_ARTIFACT` lists `SHA256SUMS`.

## WO-1: P1, the leftover-stack rule (`docs(testing)`)
In `docs/testing/strategy.md` §8, add this bullet:

> - **Leftover stacks (review M2-S1-r1 P1).** A running stack or container you did not start, test-labelled or not, is reported to the orchestrator (compose project, age, labels) before anything removes it; it is removed only after the answer.

**Commit:** `docs(testing): report a running stack you did not start before removing it (M2-S1 r1 P1)`.

## WO-2: P2, test-first history (`docs(testing)`)
In `docs/testing/strategy.md` §8, add this bullet:

> - **Test-first history in harness work (review M2-S1-r1 P2).** A harness change that has a unit or harness test lands as two commits: the failing test (RED, logged), then the support code (GREEN). The RED commit may not type-check when it imports a module that does not exist yet; that is the RED, never a stub.

**Commit:** `docs(testing): commit the failing harness test before its support code (M2-S1 r1 P2)`.

## WO-3: M2-S1 r1 C1, value-free seed scan (RED commit)
**RED** (`tests/unit/harness/seedScan.test.ts`, new; describe `seed scan`). Use `seed = { folder: 'Notestead folder abc12', tag: 'abc12', notes: [{ title: 'Notestead note abc12', body: 'Seeded body abc12 zebracorn' }, { title: 'Notestead note 2 abc12', body: 'Seeded body 2 abc12 zebracorn Δ' }] }`, and also a seed whose tag `zz9` doesn't occur in the other values: `{ folder: 'F one', tag: 'zz9', notes: [{ title: 'T one', body: 'B one' }, { title: 'T two', body: 'B two' }] }`.
- `seed-01 names the first seeded value found by a label`, with the second seed:
  - `seedLabelIn('x B two y', s)` is `'body 2'`;
  - `seedLabelIn('<b>T one</b>', s)` is `'title 1'`;
  - `seedLabelIn('F one', s)` is `'folder'`;
  - `seedLabelIn('…zz9…', s)` is `'tag'`.
- `seed-02 returns undefined when no seeded value occurs`: `seedLabelIn('nothing here', s)` is `undefined`.
- `seed-03 never returns a seeded value`: for each value `v` of both seeds (tag, folder, every title and body), `r = seedLabelIn(\`pre ${v} post\`, seed)` is defined, and `JSON.stringify(r)` contains none of the seed's values.

Log: `run test-results/verify/m2-s2/red/wo3-unit.log corepack yarn jest tests/unit/harness/seedScan.test.ts`. Expect: `Cannot find module '../../e2e/support/seedScan.ts'`.

**Commit 1:** `test(harness): failing unit test for a value-free seed scan (M2-S1 r1 C1)`.

**GREEN:**
- `tests/e2e/support/seedScan.ts` (new; no Playwright import):
  ```ts
  // Which seeded value occurs in a text, named by a label, never the value (review M2-S1-r1 C1: a failing assertion
  // prints its received value, and CI logs are public). Order: tag, folder, titles, bodies; n counts from 1.
  export interface SeedValues { folder: string; tag: string; notes: { title: string; body: string }[] }
  export const seedLabelIn = (text: string, seed: SeedValues): string | undefined => {
  	if (text.includes(seed.tag)) return 'tag';
  	if (text.includes(seed.folder)) return 'folder';
  	const t = seed.notes.findIndex(n => text.includes(n.title));
  	if (t >= 0) return `title ${t + 1}`;
  	const b = seed.notes.findIndex(n => text.includes(n.body));
  	return b >= 0 ? `body ${b + 1}` : undefined;
  };
  ```
- `tests/e2e/m2-s1/e2ee-unlock.spec.ts`:
  - delete `noSeedIn` and import `seedLabelIn`;
  - steps `3.` and NEG `2.`: `expect(seedLabelIn(await app.frameHtml(), seed), 'no seeded value in the page or any frame while encrypted').toBeUndefined()`;
  - NEG step `5.` probe: `const leaked = seedLabelIn(await app.frameHtml(), seed); if (leaked !== undefined) return \`a seeded value (${leaked}) is in the page or a frame (decrypted)\`;`;
  - step `6.`: replace the `toContain(body)` poll with a value-free verdict:
    ```ts
    for (const [i, n] of reference.entries()) {
    	await app.openNote(String(n.title));
    	await expect.poll(async () => ((await app.frameText()).includes(String(n.body)) ? 'shown' : 'not shown'),
    		{ message: `the body of seeded note ${i + 1} is shown decrypted`, timeout: 60_000, intervals: [500] }).toBe('shown');
    	await app.backToList();
    }
    ```

Log: `green/wo3-unit.log`, the same command; expect 3 of 3 to pass. The E2E part is the M2-AC2 regression in WO-17.

**Commit 2:** `test(e2e): seed scans report a label, never the seeded value (M2-S1 r1 C1)`.

## WO-4: M2-S1 r1 C5, the header comment (`chore`)
Replace lines 1 to 10 of `tests/e2e/m2-s1/e2ee-unlock.spec.ts` (the header comment, up to and including the `Needs the real upstream bundle` line) with:
```ts
// M2-S1 / M2-AC2 (docs/backlog/M2.md; docs/test-plans/M2-S1.md): another device turned E2EE on and seeded a folder and
// three notes. Before the master password the web app shows that the data is encrypted and asks for it, and nothing
// seeded is readable (plan D1); after it, every seeded title and body is shown and matches the headless REST API.
// NEG: wrong master passwords show upstream's errors; no seeded text reaches the page or the local profile (D2), and
// the server's items stay byte-identical.
// Needs the real upstream bundle in the web image: NOTESTEAD_WEB_ARTIFACT=<CI artifact dir> (or NOTESTEAD_WEB_IMAGE).
```
Check that no header line is longer than 120 characters: `awk 'NR<=6 && length>120' tests/e2e/m2-s1/e2ee-unlock.spec.ts` prints nothing. If a line is too long, rewrap it without changing the words.

**Commit:** `chore(e2e): shorten the M2-AC2 spec header (M2-S1 r1 C5)`.

## WO-5: M2-S1 r1 C2, the network policy over the whole test (RED commit)
**RED** (`tests/unit/harness/network.test.ts`, extend). Keep `app = 'http://127.0.0.1:41234'`.
- `net-13 end of test: an allowed planted request is left out, every other violation is reported`:
  - entries `GET https://notestead-control.invalid/m2-ac1`, `GET ${app}/joplin-server/shares/x` and `GET https://evil.example/x`;
  - `endOfTestViolations(entries, app, ['https://notestead-control.invalid/'])` equals `['GET http://127.0.0.1:41234/joplin-server/shares/x: same-origin request to the sync target outside /joplin-server/api/', 'GET https://evil.example/x: cross-origin request']`.
- `net-14 an allowed prefix never covers another host`: the entry `GET https://notestead-control.invalid.evil.example/x` with the same allow list is reported.
- `net-15 the recorder only allows prefixes that end in a slash`:
  - `const rec = recordNetwork({ on: () => undefined } as unknown as BrowserContext)`;
  - `expect(() => rec.allow('https://x.invalid')).toThrow(/must end with "\/"/)`;
  - `rec.allow('https://x.invalid/')`, then `rec.allowed()` equals `['https://x.invalid/']`.

Log: `red/wo5-unit.log` (`corepack yarn jest tests/unit/harness/network.test.ts`). Expect net-13 and net-14 to fail (`endOfTestViolations is not a function`) and net-15 to fail (`rec.allow is not a function`). NET-01 to NET-12 still pass.

**Commit 1:** `test(harness): failing unit tests for the end-of-test network policy (M2-S1 r1 C2)`.

**GREEN:**
- `tests/e2e/support/network.ts`:
  ```ts
  // The policy over a whole test (review M2-S1-r1 C2): every violation recorded so far, except the requests a test plants
  // on purpose and names with `allow` (a URL prefix ending in "/", so it never covers another host).
  export const endOfTestViolations = (entries: NetEntry[], appOrigin: string, allowed: string[]): string[] =>
  	violationLines(classifyRequests(entries.filter(e => !allowed.some(p => e.url.startsWith(p))), appOrigin));
  ```
  `NetworkRecorder` gains `allow: (prefix: string) => void` (throw `new Error(\`an allowed prefix must end with "/": ${prefix}\`)` otherwise) and `allowed: () => string[]` (a copy).
- `tests/e2e/support/fixtures.ts`, `webNetwork`:
  ```ts
  webNetwork: async ({ webApp, stack }, use, testInfo) => {
  	const recorder = recordNetwork(webApp.context);
  	await use(recorder);
  	// The whole test's traffic, checked as the context is about to close (review M2-S1-r1 C2): a request the app makes
  	// late, such as a periodic re-sync, is seen too.
  	const late = endOfTestViolations(recorder.entries(), new URL(webApp.baseURL).origin, recorder.allowed());
  	if (failed(testInfo) || late.length > 0) await attachText(testInfo, 'network.log', redactText(recorder.text(), workerSecrets(stack)));
  	expect(late, 'network policy over the whole test, checked at its end (M2-S1 r1 C2)').toEqual([]);
  },
  ```
  Import `expect` from `@playwright/test` in the file (it already re-exports it), and update the header comment's `webNetwork` line.
- `tests/e2e/m2-s1/sync-through-proxy.spec.ts`, step `7.`: the first statement becomes `webNetwork.allow('https://notestead-control.invalid/');`, with the comment `// The planted control is named, so the end-of-test check (C2) leaves out exactly this request.`

Log: `green/wo5-unit.log`; all NET tests pass. The E2E proof is sensitivity run S7 (WO-17).

**Commit 2:** `test(harness): check the network policy over the whole test at fixture teardown (M2-S1 r1 C2)`.

## WO-6: F1, REST queries that see conflict copies (RED commit)
**RED** (`tests/unit/harness/restQueries.test.ts`, new; describe `rest queries`). Write a fake `get` that records every path. It answers from a table keyed by path without the `page=` part, and serves `page=N` from the N-th array of that entry.
- `rest-01 notesTitled asks for conflict copies and returns them`:
  - with `include_conflicts=1` in the path, the fake answers `{ items: [{ id: 'a', title: 'T', is_conflict: 0 }, { id: 'b', title: 'T', is_conflict: 1 }, { id: 'c', title: 'U', is_conflict: 0 }], has_more: false }`; without it, only `a` and `c`;
  - `notesTitled(get, 'T').map(n => n.id)` is `['a', 'b']`;
  - the recorded path matches `/^\/notes\?include_conflicts=1&fields=id,title,is_conflict,deleted_time&limit=100&page=1$/`.
- `rest-02 trashed notes only when asked`: the default path has no `include_deleted`, and `{ includeDeleted: true }` adds `include_deleted=1`.
- `rest-03 allItems pages until has_more is false`: page 1 is `{ items: [x], has_more: true }` and page 2 is `{ items: [y], has_more: false }`. The result is `[x, y]`, and the paths asked are `page=1` then `page=2`.
- `rest-04 a failed request throws naming the path and status, never the body`:
  - `{ status: 404, body: 'nstbodymarker' }` throws `/GET \/tags\/t1\/notes\?fields=id&limit=100&page=1: HTTP 404/`, and the message does not contain `nstbodymarker`;
  - `{ error: 'probe failed' }` throws with `probe failed`.
- `rest-05 tag helpers`:
  - `tagNoteIds(get, 't1')` returns the sorted ids;
  - `noteTagTitles(get, 'n1')` returns the sorted titles of `/notes/n1/tags`;
  - `withQuery('/a?x=1', 'y=2')` is `'/a?x=1&y=2'`, and `withQuery('/a', 'y=2')` is `'/a?y=2'`.

Log: `red/wo6-unit.log`. Expect `Cannot find module '../../e2e/support/restQueries.ts'`.

**Commit 1:** `test(harness): failing unit tests for REST queries that include conflict copies (M2-S2 F1)`.

**GREEN:**
- `tests/e2e/support/restQueries.ts` (new; no Playwright import):
  ```ts
  // Queries over the headless REST Data API for data-level assertions (docs/test-plans/M2-S2.md F1). Pure: they take the
  // `get` of the dataApi fixture and import nothing from Playwright, so the unit layer tests them.
  export interface RestResult { status?: number; body?: unknown; error?: string }
  export type RestGet = (path: string) => RestResult;
  export type Item = Record<string, unknown>;
  export const withQuery = (path: string, query: string): string => `${path}${path.includes('?') ? '&' : '?'}${query}`;
  export const allItems = (get: RestGet, path: string, fields: string, maxPages = 50): Item[] // throws `GET <path with query>: <error | HTTP status>`
  // Every note titled `title`, conflict copies included (CLI 3.7.1 leaves them out of GET /notes unless asked: F1);
  // trashed notes only with includeDeleted.
  export const notesTitled = (get: RestGet, title: string, opts: { includeDeleted?: boolean } = {}): Item[] =>
  	allItems(get, `/notes?include_conflicts=1${opts.includeDeleted ? '&include_deleted=1' : ''}`, 'id,title,is_conflict,deleted_time').filter(n => n.title === title);
  export const foldersTitled = (get: RestGet, title: string): Item[] => allItems(get, '/folders', 'id,title,parent_id').filter(f => f.title === title);
  export const tagsTitled = (get: RestGet, title: string): Item[] => allItems(get, '/tags', 'id,title').filter(t => t.title === title);
  export const tagNoteIds = (get: RestGet, tagId: string): string[] => allItems(get, `/tags/${tagId}/notes`, 'id').map(n => String(n.id)).sort();
  export const noteTagTitles = (get: RestGet, noteId: string): string[] => allItems(get, `/notes/${noteId}/tags`, 'id,title').map(t => String(t.title)).sort();
  ```
- `tests/e2e/support/dataApi.ts`:
  - `notesTitled(dataApi, title, opts = {})` delegates to `restQueries.notesTitled(restGet(dataApi), title, opts)`;
  - add `export const restGet = (dataApi: DataApi): RestGet => path => dataApi.get(path);`;
  - keep `ok` and `pick` as they are.

  M1-S7 and M2-S1 keep calling `notesTitled(dataApi, title)` unchanged. They now see conflict copies too.

Log: `green/wo6-unit.log`; 5 of 5 pass. The E2E regression (M1-AC21 step 6, M2-AC2 step 9) is in WO-17.

**Commit 2:** `test(harness): REST queries include conflict copies, so "no conflict copy" checks can see one (M2-S2 F1)`. The body names the strengthened M1-AC21 and M2-AC2 checks.

## WO-7: `e2eeAccount` seed extras (RED commit; heavy)
**RED** (`tests/e2e/harness/e2ee-seed-extras.spec.ts`, new):
```ts
// The e2eeAccount seed extras (docs/test-plans/M2-S2.md D7; ADR-0007 §Fixtures, A2): with e2eeSeed.extras, the other device
// also seeds a to-do with todo_due, a tag on note 1 and a text attachment on a note of its own. They reach the headless
// REST API decrypted, and the server holds them encrypted.
test.describe('M2-S2 e2eeAccount seed extras', () => {
	test.use({ e2eeSeed: { notes: 1, extras: true } });
	test('M2-S2-SEED-01 the seeded to-do with todo_due, the seeded tag and the attachment reach the headless REST API decrypted, and the server holds them encrypted', async ({ stack, e2eeAccount, headlessService, dataApi }) => { … });
});
```
Steps:
1. `1. the account records the extras`: `todo = e2eeAccount.seedTodo`, `tag = e2eeAccount.seedTagTitle`, `att = e2eeAccount.seedAttachment`; each `toBeDefined()`. This is where RED fails. `note1 = e2eeAccount.notes![0]`.
2. `2. the to-do`: `pick(ok(dataApi.get(\`/notes/${todo.id}?fields=id,title,is_todo,todo_due,todo_completed,parent_id\`)), [...])` equals `{ id, title, is_todo: 1, todo_due: seedTodoDue, todo_completed: 0, parent_id: <note 1's parent_id from GET /notes/:note1?fields=parent_id> }`.
3. `3. the tag`:
   - `tagsTitled(restGet(dataApi), tag)` has length 1;
   - `tagNoteIds(…, id)` equals `[note1.id]`;
   - `noteTagTitles(…, note1.id)` equals `[tag]`.
4. `4. the attachment`:
   - `res = allItems(restGet(dataApi), \`/notes/${att.noteId}/resources\`, 'id,title,size')` has length 1;
   - `GET /notes/:noteId?fields=body`'s body contains `(:/${res[0].id})`;
   - `GET /resources/:id/file` has status 200 and a `string` body, with `createHash('sha256').update(body, 'utf8').digest('hex') === att.sha256` and `Buffer.byteLength(body) === att.size`.
5. `5. the server holds them encrypted`:
   - `serverItemNames` contains `.resource/${res[0].id}` and `${todo.id}.md`;
   - the content of `.resource/<id>` doesn't include `Notestead seeded attachment`;
   - the content of `${todo.id}.md` matches `/^encryption_applied: 1$/m` and doesn't include `e2eeAccount.seedTag`.

   If the server lists resources under a different name, stop and report the item names. Report the names only, never contents.

Run: first heavy run of the story, `T=60m run test-results/verify/m2-s2/red/wo7-seed.log env NOTESTEAD_KEEP_IMAGE=1 corepack yarn playwright test tests/e2e/harness/e2ee-seed-extras.spec.ts`. It builds all three images (expect 20 to 40 minutes). Expect a failure at step 1 (`seedTodo`: `Received: undefined`), or a TypeScript-stripping error on the unknown `extras` option. Either is RED for the missing feature; record which.

**Commit 1:** `test(harness): failing spec for the e2eeAccount to-do, tag and attachment seed (M2-S2 D7)`.

**GREEN:**
- `tests/stack/stack.ts`:
  - `export const seedTodoDue = Date.UTC(2031, 0, 15, 8, 30); // the seeded to-do's due date (epoch ms), fixed and in the future`
  - `export interface SeedOptions { notes?: number; extras?: boolean }`; `enableE2ee(state, account, label, seed: SeedOptions = {})`.
  - `Account` gains:
    ```ts
    seedTodo?: { id: string; title: string; due: number };
    seedTagTitle?: string;
    seedAttachment?: { noteId: string; noteTitle: string; fileName: string; sha256: string; size: number };
    ```
  - When `seed.extras` is set, with the existing `tag`:
    - `todo = { title: \`Notestead todo ${tag}\`, due: seedTodoDue }`;
    - `seedTag = { title: \`nst-seed-${tag}\`, note: notes[0].title }`;
    - `text = \`Notestead seeded attachment ${tag}\n\`.repeat(64)`;
    - `attachment = { note: \`Notestead attachment note ${tag}\`, fileName: \`nst-seed-${tag}.txt\`, contentBase64: Buffer.from(text, 'utf8').toString('base64') }`.

    Pass `extras: { todo, tag: seedTag, attachment }` in the device's stdin JSON. After the run, set `account.seedTodo` (id from the result), `account.seedTagTitle`, and `account.seedAttachment` (`sha256` and `size` of `text` computed here, `noteId` from the result).
  - Without `extras`, the stdin JSON and the result are as today.
- `tests/fixtures/m1-s5/device/device.mjs`:
  - extend the header comment's Input/Output lines;
  - `plan.extras` is optional;
  - validate each extras string with the same unsafe-value check, `fileName` against `/^[a-z0-9.-]+$/`, and `due` with `Number.isSafeInteger`;
  - write `/tmp/home/<fileName>` from `contentBase64` (mode `0o600`);
  - after the `mknote`/`set` lines and before `sync`, add to the batch:
    ```
    mktodo "<todo.title>"
    set "<todo.title>" todo_due <todo.due>
    tag add "<tag.title>" "<tag.note>"
    mknote "<attachment.note>"
    attach "<attachment.note>" "/tmp/home/<fileName>"
    ```
  - after `ls --format json`, find the to-do and the attachment note by title (throw if either is missing), and add `todo: { id, title }` and `attachmentNote: { id, title }` to `RESULT`.
- `tests/e2e/support/fixtures.ts`: `e2eeSeed: [{ notes: 1 }, { option: true }]`, typed `{ notes: number; extras?: boolean }`, and the header comment.

Run: `T=60m run test-results/verify/m2-s2/green/wo7-seed.log env NOTESTEAD_KEEP_IMAGE=1 NOTESTEAD_WEB_IMAGE=localhost/notestead-web:stack-test NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test corepack yarn playwright test tests/e2e/harness/e2ee-seed-extras.spec.ts`. This deliberately has no `NOTESTEAD_DEVICE_IMAGE`, so the device image is rebuilt with the new `device.mjs`. Expect a pass. If the CLI refuses a batch line, stop and report the device log (`test-results/…/device-*.log` from the stack's logs dir, redacted).

**Commit 2:** `test(harness): e2eeAccount seeds a to-do with todo_due, a tag and an attachment on request (M2-S2 D7)`.

## WO-8: Due-date arithmetic and the `Europe/Amsterdam` context (RED commit, then one more commit)
**RED** (`tests/unit/harness/dueDate.test.ts`, new; describe `due dates`):
- `due-01 the Amsterdam wall clock in summer time`: `partsIn(Date.UTC(2027, 6, 15, 12, 30), 'Europe/Amsterdam')` equals `{ year: '2027', month: '07', day: '15', hour: '14', minute: '30' }`.
- `due-02 … in winter time`: `partsIn(Date.UTC(2026, 10, 15, 13, 30), 'Europe/Amsterdam')` gives `14:30` on `15/11/2026`.
- `due-03 midnight is 00, never 24`: `partsIn(Date.UTC(2026, 10, 14, 23, 5), 'Europe/Amsterdam')` equals `{ year: '2026', month: '11', day: '15', hour: '00', minute: '05' }`.
- `due-04 nextWholeMinute rounds up to a whole minute`:
  - `nextWholeMinute(Date.UTC(2026, 9, 21, 10, 0, 15), 150_000) === Date.UTC(2026, 9, 21, 10, 3)`;
  - `nextWholeMinute(Date.UTC(2026, 9, 21, 10, 0, 0), 60_000) === Date.UTC(2026, 9, 21, 10, 1)`.
- `due-05 the datetime-local value, and the zone argument matters`:
  - `datetimeLocalValue(partsIn(Date.UTC(2027, 6, 15, 12, 30), 'Europe/Amsterdam')) === '2027-07-15T14:30'`;
  - `partsIn(Date.UTC(2027, 6, 15, 12, 30), 'UTC').hour === '12'`.

Log: `red/wo8-unit.log` (module not found).

**Commit 1:** `test(harness): failing unit tests for due-date arithmetic in Europe/Amsterdam (M2-AC5)`.

**GREEN:** `tests/e2e/support/dueDate.ts` (new; no Playwright import):
```ts
// Due dates for the to-do tests (docs/test-plans/M2-S2.md D5): the wall clock of an epoch in a given zone, computed with
// Intl and an explicit timeZone, so the host's own zone never matters.
export const userTimeZone = 'Europe/Amsterdam';
export interface LocalParts { year: string; month: string; day: string; hour: string; minute: string }
export const partsIn = (epochMs: number, timeZone: string): LocalParts // Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts
export const datetimeLocalValue = (p: LocalParts): string => `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
export const nextWholeMinute = (nowMs: number, aheadMs: number): number => Math.ceil((nowMs + aheadMs) / 60_000) * 60_000;
```
Log: `green/wo8-unit.log`; 5 of 5 pass.

**Commit 2:** `test(harness): due-date arithmetic in Europe/Amsterdam (M2-AC5)`.

**Commit 3**, `tests/e2e/support/fixtures.ts`:
- add the option `webTimezone: [userTimeZone, { option: true }]` (type `string` in `TestFixtures`);
- `webApp` takes `webTimezone` and calls `browser.newContext({ baseURL: stack.webUrl, locale: 'en-GB', timezoneId: webTimezone })`;
- add a comment line: `// Europe/Amsterdam: the user's zone (gate 1, Q9); M2-AC5 asserts due dates as epochs in it (docs/test-plans/M2-S2.md D5).`

Subject: `test(harness): web app contexts run in Europe/Amsterdam (webTimezone option, M2-AC5)`. Its proof is M2-AC5's in-page control and sensitivity run S5.

## WO-9: The `Notification` spy (RED commit)
**RED** (`tests/e2e/harness/notification-spy.spec.ts`, new; fixtures `{ webApp }` only, pages on the stack's `web` origin, no app code):
```ts
// The Notification spy of M2-AC5's NEG (docs/test-plans/M2-S2.md D6), proven on plain same-origin pages.
test.describe('M2-S2 Notification spy', () => { … });
```
- `M2-S2-SPY-01 counts Notification constructions, permission requests and service-worker notifications in the main frame`:
  - `await installNotificationSpy(webApp.context)`, then `goto(new URL('/manifest.json', webApp.baseURL).href)`;
  - `readNotificationSpy(page).main` matches `{ installed: true, constructed: 0, requested: 0, shown: 0 }`, and `main.native` is `true`. If `native` is `false`, Chromium has no `Notification` here: stop and report;
  - `page.evaluate` with `globalThis` casts runs:
    - `new N('nst-spy-test')`;
    - `void N.requestPermission()`, not awaited;
    - `try { void SWR.prototype.showNotification.call({}, 'x') } catch { /* illegal invocation */ }`;
  - then `{ constructed, requested, shown }` of `main` equal `{ 1, 1, 1 }`.
- `M2-S2-SPY-02 a reload gives a new document id and fresh counters`: construct one, keep `docId`, `page.reload()`. Then `main.docId` differs, and `main.constructed` is 0.
- `M2-S2-SPY-03 a same-origin iframe has its own spy and counts in the totals`:
  - append `<iframe src="/manifest.json">` in the page;
  - `expect.poll(() => readNotificationSpy(page).then(r => r.framesWithSpy)).toBe(2)`;
  - in that child frame (`page.frames().find(f => f !== page.mainFrame())`), construct one;
  - the totals have `constructed` 1, and `main.constructed` is 0.

Log: `red/wo9-spy.log` (`T=30m run … env $IMG corepack yarn playwright test tests/e2e/harness/notification-spy.spec.ts`). Expect a load failure, `Cannot find module '../support/notificationSpy.ts'`.

**Commit 1:** `test(harness): failing spec for the Notification spy (M2-AC5 NEG)`.

**GREEN:** `tests/e2e/support/notificationSpy.ts` (new):
```ts
// A spy on the web notification APIs for M2-AC5's NEG (docs/test-plans/M2-S2.md D6; limitation L1). Installed as a
// context init script, it runs in every frame before any page script and counts new Notification(…),
// Notification.requestPermission(…) and ServiceWorkerRegistration.prototype.showNotification(…). Each document gets a
// random docId, so a reload (which resets the counts) is detected. Notifications a service worker shows from its own
// scope are out of its reach; upstream's service worker shows none.
import type { BrowserContext, Page } from '@playwright/test';
export interface SpyState { installed: true; native: boolean; docId: string; constructed: number; requested: number; shown: number }
export interface SpyReading { main?: SpyState; frames: number; framesWithSpy: number; constructed: number; requested: number; shown: number }

const spy = (): void => {
	const g = globalThis as unknown as Record<string, unknown>;
	if (g.__nstNotifications) return;
	type NotificationCtor = (new (...args: unknown[]) => object) & { permission?: string; requestPermission?: (...args: unknown[]) => unknown; prototype: object };
	const original = g.Notification as NotificationCtor | undefined;
	const state = { installed: true, native: typeof original === 'function', docId: `${Date.now()}-${Math.random().toString(16).slice(2)}`, constructed: 0, requested: 0, shown: 0 };
	Object.defineProperty(g, '__nstNotifications', { value: state });
	const Spy = function (this: unknown, ...args: unknown[]): object {
		state.constructed++;
		return original ? Reflect.construct(original, args, new.target ?? Spy) as object : {};
	} as unknown as NotificationCtor;
	Spy.prototype = original?.prototype ?? {};
	Object.defineProperty(Spy, 'permission', { get: () => original?.permission ?? 'denied' });
	Spy.requestPermission = (...args: unknown[]) => {
		state.requested++;
		return original?.requestPermission?.(...args) ?? Promise.resolve('denied');
	};
	g.Notification = Spy;
	const registration = g.ServiceWorkerRegistration as { prototype: { showNotification?: (...args: unknown[]) => unknown } } | undefined;
	const show = registration?.prototype.showNotification;
	if (registration && show) {
		registration.prototype.showNotification = function (this: unknown, ...args: unknown[]) {
			state.shown++;
			return show.apply(this, args);
		};
	}
};

export const installNotificationSpy = async (context: BrowserContext): Promise<void> => context.addInitScript(spy);
// The spy of every frame of the page (a frame that detached while it was read counts as one without a spy).
export const readNotificationSpy = async (page: Page): Promise<SpyReading> // main = the main frame's state; totals summed over all frames
```
If ESLint rejects a form here (`func-style`, `no-invalid-this`, …), change the form, not the behaviour, and say so in the commit body.

Log: `green/wo9-spy.log`; 3 of 3 pass.

**Commit 2:** `test(harness): Notification spy for the web app's frames (M2-AC5 NEG, L1)`.

## WO-10: `clearLikeUser` (RED commit)
**RED** (`tests/unit/harness/typeLikeUser.test.ts`, extend). In `fakeField`:
- add a `selected` flag: `press('ControlOrMeta+a')` sets it, and `press('Backspace')` empties `value` if it is set (then clears the flag);
- add a new option `refuseClear?: boolean` that makes `Backspace` do nothing.

New describe `clearLikeUser`:
- `clear-01 empties the field with select-all and Backspace, as real keys`: with `initialValue: 'old title'`, it resolves, `fake.value()` is `''`, and `keys(fake)` equals `['click', 'press ControlOrMeta+a', 'press Backspace']`.
- `clear-02 fails, without the value, when the field stays filled`: with `refuseClear: true, initialValue: 'old title'` and `{ timeoutMs: 300 }`, it rejects with `/the field to be empty/`, and the message doesn't contain `old title`.

Log: `red/wo10-unit.log`. Expect `clearLikeUser is not a function`; the other 14 tests pass.

**Commit 1:** `test(harness): failing unit tests for clearing a field like a user (M2-AC3)`.

**GREEN** (`tests/e2e/support/typeLikeUser.ts`):
```ts
// Empties a text field as a user does: select all, then Backspace (real key events, never fill), and waits until the
// app shows it empty. Used before typing a new title or name over an old one (M2-AC3, M2-AC4).
export const clearLikeUser = async (field: Locator, opts: { timeoutMs?: number } = {}): Promise<void> => {
	await field.click();
	await field.press('ControlOrMeta+a');
	await field.press('Backspace');
	await waitFor('the field to be empty', async () => ((await field.inputValue()) === '' ? true : undefined), { timeoutMs: opts.timeoutMs ?? 30_000, intervalMs: 100 });
};
```
Log: `green/wo10-unit.log`.

**Commit 2:** `test(harness): clear a field like a user before typing over it (M2-AC3)`.

## WO-11: Page objects and flows (one commit; checked by WO-12 to WO-14)
Everything below goes in `tests/e2e/support/pages/joplinWebApp.ts` and `tests/e2e/support/flows.ts`, in the existing style: role-based locators, upstream strings exact (plan §Page objects table), typing only through the helpers. Read each upstream file named here once before you write its page object.

**`JoplinWebApp` additions:**
```ts
public addNewButton(): Locator { return this.page.getByRole('button', { name: 'Add new', exact: true }); }
// The FAB's menu (NewNoteButton.tsx): a provisional note in the current notebook, opened in the note screen.
public async newNote(): Promise<NoteScreen>      // click addNewButton(), then getByRole('button', { name: 'New note', exact: true }); return an opened NoteScreen (waitOpen)
public async newTodo(): Promise<NoteScreen>      // same with 'New to-do'
public todoCheckbox(title: string): Locator { return this.page.getByRole('checkbox', { name: `to-do: ${title}`, exact: true }); }
// A notebook in the side menu; depth > 0 carries upstream's " (level n)" in its accessible name (side-menu-content.tsx:272).
public folderInSideMenu(title: string, depth = 0): Locator   // depth 0: as today; else getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}\\s+\\(level ${depth}\\)$`) })
public expandFolder(title: string): Locator { return this.page.getByRole('button', { name: `Expand ${title}`, exact: true }); }
public notesHeading(title: string): Locator { return this.page.getByRole('heading', { name: title, exact: true }); }
public async openFolder(title: string, depth = 0): Promise<void>   // openSidebar(); folderInSideMenu(title, depth).click(); notesHeading(title).waitFor()
public async createNotebook(title: string): Promise<void>          // openSidebar(); click getByRole('button', { name: 'New Notebook', exact: true }); f = new FolderScreen(page); f.heading().waitFor(); typeLikeUser(f.titleField(), title); f.save(); notesHeading(title).waitFor()
public async editNotebook(title: string, depth = 0): Promise<FolderScreen>
	// openSidebar(); folderInSideMenu(title, depth).click({ button: 'right' }) (upstream's onContextMenu = long press);
	// menu = getByTestId('menu-content-open'); menu.getByRole('heading', { name: `Notebook: ${title}`, exact: true }).waitFor();
	// menu.getByRole('button', { name: 'Edit', exact: true }).click(); f.heading().waitFor(); return f
public async openTagsScreen(): Promise<TagsScreen>                 // openSidebar(); getByRole('button', { name: 'Tags', exact: true }).click(); s.heading().waitFor()
```
`escapeRegExp` is a local helper (`s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`).

**`NoteScreen`** (new class):
```ts
public titleField(): Locator { return this.page.getByPlaceholder('Add title', { exact: true }); }
public async waitOpen(): Promise<void> { await this.titleField().waitFor({ timeout: 60_000 }); }
public async typeTitle(text: string, opts: { replace?: boolean } = {}): Promise<void> // replace: clearLikeUser first; then typeLikeUser(titleField(), text)
public editToggle(): Locator { return this.page.getByRole('button', { name: 'Edit', exact: true }); }
// Upstream's Markdown editor: CodeMirror in an iframe (ExtendedWebView on web, MarkdownEditor.tsx); found as the one frame
// with a .cm-content.
public async editor(): Promise<Locator>        // waitFor('the Markdown editor', over page.frames(): the frame where locator('.cm-content').count() === 1 → that locator; detached frames skipped), 60 s
public async startEditing(): Promise<Locator>  // if (await editToggle().isVisible()) click it; return editor()
public async editorText(): Promise<string>     // (await editor()).evaluate: the textContent of each .cm-line, joined with '\n' (globalThis/unknown casts as in perFrame)
// Typed with real key events into the editor (Enter for '\n'); never a secret (refused with SecretInVisibleFieldError,
// using secretIn(text, knownSecretsNow())). replace: select all and Backspace first, until the editor is empty;
// otherwise the text goes at the end (ControlOrMeta+End). Done when the editor's lines equal the old text + the typed text.
public async typeBody(text: string, opts: { replace?: boolean } = {}): Promise<void>
	// e = startEditing(); e.click(); [replace: page.keyboard.press('ControlOrMeta+a'), press('Backspace'), waitFor editorText() === '']
	// [else page.keyboard.press('ControlOrMeta+End')]; before = editorText(); e.pressSequentially(text);
	// waitFor('the editor to hold the typed body', editorText() === before + text), 30 s
// Upstream's own test id for the header menu trigger (ScreenHeader/Menu.tsx; its Note.test.tsx uses it too).
public actionsButton(): Locator { return this.page.getByTestId('screen-header-menu-trigger'); }
public async menuAction(title: string): Promise<void>  // actionsButton().click(); getByTestId('menu-content-open').getByRole('button', { name: title, exact: true }).click()
// The header's notebook dropdown: a button named by the current notebook, with upstream's ▼ (Dropdown.tsx).
public folderPicker(current: string): Locator { return this.page.getByRole('button', { name: current, exact: true }).filter({ has: this.page.getByText('▼', { exact: true }) }); }
public async moveTo(current: string, target: string): Promise<void> // folderPicker(current).click(); getByRole('menuitem', { name: target, exact: true }).click(); folderPicker(target).waitFor()
public async openTags(): Promise<TagsDialog>      // menuAction('Tags'); d.searchField().waitFor()
public async openAlarm(): Promise<AlarmDialog>    // menuAction('Set alarm'); a.input().waitFor()
public async deleteToTrash(): Promise<void>       // menuAction('Delete') (to the trash, no confirmation, the screen stays: F4)
```

**`AlarmDialog`** (new):
```ts
public input(): Locator { return this.page.locator('input[type="datetime-local"]'); } // no ARIA role exists for it
// Typed segment by segment as a user does in Chromium's en-GB datetime-local (dd/mm/yyyy, hh:mm): the focus starts on
// the day; day and month advance by themselves; ArrowRight leaves the year. Done when the input holds the full value.
public async enterLocal(parts: LocalParts): Promise<void>
	// input().pressSequentially(`${day}${month}${year}`); page.keyboard.press('ArrowRight'); page.keyboard.type(`${hour}${minute}`);
	// waitFor(`the date input to hold ${datetimeLocalValue(parts)}`, inputValue() === datetimeLocalValue(parts)), 10 s
// Save alarm, then upstream's web-only alert (Note.tsx:1220): its message is returned and it is accepted.
public async save(): Promise<string> // const d = page.waitForEvent('dialog', { timeout: 30_000 }); click getByRole('button', { name: 'Save alarm', exact: true }); m = (await d).message(); await (await d).accept(); return m
```
**Stop condition (F6):** if `enterLocal` times out, make a scratch copy (never committed) and try `Tab` instead of `ArrowRight`. Report the `inputValue()` you saw with each, plus an `ariaSnapshot()` of the dialog. Don't use `fill`.

**`TagsDialog`** (new):
```ts
public searchField(): Locator { return this.page.getByPlaceholder('Search tags', { exact: true }); }
public removeButton(title: string): Locator { return this.page.getByRole('button', { name: `Remove ${title}`, exact: true }); }
public async addNew(title: string): Promise<void> // typeLikeUser(searchField(), title); getByRole('option', { name: 'Add new', exact: true }).click(); removeButton(title).waitFor()
public async remove(title: string): Promise<void> // removeButton(title).click(); removeButton(title).waitFor({ state: 'detached' })
public async apply(): Promise<void>               // getByRole('button', { name: 'Apply', exact: true }).click(); searchField().waitFor({ state: 'detached' })
```
**`TagsScreen`** (new):
```ts
public heading(): Locator { return this.page.getByRole('heading', { name: 'Tags', exact: true }); }
public tagItem(title: string): Locator { return this.page.getByRole('button', { name: title, exact: true }); }
public async rename(oldTitle: string, newTitle: string): Promise<void>
	// tagItem(old).click({ button: 'right' }); prompt = getByTestId('prompt-dialog');
	// prompt.getByRole('button', { name: 'Rename', exact: true }).click();
	// field = getByTestId('prompt-dialog').getByRole('textbox', { name: 'Rename tag:', exact: true }); clearLikeUser(field); typeLikeUser(field, newTitle);
	// getByTestId('prompt-dialog').getByRole('button', { name: 'OK', exact: true }).click(); tagItem(newTitle).waitFor()
```
**`FolderScreen`** (new):
```ts
public heading(): Locator { return this.page.getByRole('heading', { name: 'Edit notebook', exact: true }); }
public titleField(): Locator { return this.page.getByPlaceholder('Enter notebook title', { exact: true }); }
public parentPicker(current: string): Locator   // as NoteScreen.folderPicker; a top-level notebook shows 'Select parent notebook'
public async rename(newTitle: string): Promise<void>           // clearLikeUser(titleField()); typeLikeUser(titleField(), newTitle)
public async setParent(current: string, parent: string): Promise<void> // parentPicker(current).click(); getByRole('menuitem', { name: parent, exact: true }).click(); parentPicker(parent).waitFor()
public async save(): Promise<void> // getByRole('button', { name: 'Save changes', exact: true }).click(); heading().waitFor({ state: 'detached' })
```

**Flows** (`tests/e2e/support/flows.ts`):
```ts
// L18: on an E2EE account nothing syncs before the master password, so every M2-S2 test unlocks first and waits for
// the first seeded note (docs/test-plans/M2-S2.md D1).
export const openUnlockedWebApp = async (app: JoplinWebApp, origin: string, syncUrl: string, account: Account): Promise<void>
	// configureJoplinServerSync; expect(app.decryptionBanner()).toBeVisible({ timeout: firstSyncTimeoutMs }); unlockE2ee;
	// expect.poll(() => app.noteInList(account.notes[0].title).isVisible(), 3 min).toBe(true) (throw if the account has no seeded note)

export const deltaPath = '/joplin-server/api/items/root:/:/delta';
// One web sync (docs/test-plans/M2-S2.md D3), from the note list: idle first, one press of Synchronise, then a delta
// request after the press, idle again, and a report with Completed: and no Last error:. Ends with the side menu closed.
export const syncWebOnce = async (app: JoplinWebApp, network: NetworkRecorder, timeoutMs = 3 * 60_000): Promise<{ report: string; durationMs: number }>
	// openSidebar(); expect(app.syncIdle(), 'no sync running before the web sync').toBeVisible({ timeout: timeoutMs });
	// mark = network.entries().length; app.syncIdle().click();
	// expect.poll(probe, { timeout: timeoutMs, intervals: [1_000] }).toBe('completed'), the probe in this order:
	//   no GET with decodeURIComponent(pathname) === deltaPath and status 200 in entries().slice(mark) → 'no delta request since the press'
	//   !syncIdle().isVisible() → 'a sync is running';  report = syncReport(); /Last error:/ → `the sync reported an error: ${report}`
	//   /\bCompleted: / → 'completed', else `no completed report yet: ${JSON.stringify(report)}`
	// closeSidebar(); return { report, durationMs }

// One web sync, then one headless sync of the test's own service (D2, D3): one "cycle" of M2-S2.
export const syncWebThenHeadless = async (app: JoplinWebApp, network: NetworkRecorder, stack: StackState, service: HeadlessService): Promise<{ webMs: number; headlessMs: number; webReport: string }>
```
**Check:** lint and tsc on the two files. The flows are exercised by WO-12 to WO-14.

**Commit:** `test(harness): page objects and flows for notes, notebooks, tags and to-dos (M2-S2)`. The body cites plan D1, D3 and F3 to F7.

## WO-12: `tests/e2e/m2-s2/notes.spec.ts` (M2-AC3)
**Header comment:** the AC, D1 to D4, the plan path, and the bundle requirement (as the M2-S1 specs).

**Setup:**
- `test.describe('M2-S2 notes in the web app', () => { test.describe.configure({ timeout: 25 * 60_000 }); … })`.
- Fixtures: `{ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }`.
- Start with `await requireUpstreamBundle(stack, 'M2-S2')`.
- Locals:
  - `get = restGet(dataApi)`;
  - `run = randomBytes(4).toString('hex')`;
  - `T1 = \`Notestead web note ${run}\``, `B1 = \`Body typed in the web app ${run}\``;
  - `T2 = \`Notestead edited note ${run} Δ\``, `B2 = \`Edited body ${run}\nSecond line ✓ ünïcödé\``;
  - `target = \`Notestead target ${run}\``.
- Helpers in the file:
  - `const noteFields = 'id,title,body,parent_id,is_todo,deleted_time,is_conflict,encryption_applied'`.
  - `readNote(id)` = `pick(ok(dataApi.get(\`/notes/${id}?fields=${noteFields}\`), …), noteFields.split(','))`.
  - `cycle(label)` = `syncWebThenHeadless(app, webNetwork, stack, headlessService)`, then `test.info().annotations.push({ type: 'cycle', description: \`${label}: web ${webMs} ms, headless ${headlessMs} ms\` })`.

**`M2-AC3 a note created, edited (typed like a user), moved and deleted to the trash in the web UI is reflected exactly in the headless REST API after one web sync and one headless sync each`:**
0. `0. data level before: the seeded note's folder`: `seedFolderId = ok(dataApi.get(\`/notes/${note1.id}?fields=parent_id\`)).parent_id`; `GET /folders/:id?fields=title` is `seed.folder` (`e2eeAccount.folder`).
1. `1. open the web app and unlock it`: `openUnlockedWebApp(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount)`.
2. `2. create the target notebook in the UI`: `app.createNotebook(target)`.
3. `3. create the note in the seeded notebook, typed like a user`:
   - `app.openFolder(e2eeAccount.folder!)`;
   - `n = await app.newNote()`;
   - `n.typeTitle(T1)`, `n.typeBody(B1)`;
   - `app.backToList()`;
   - `await expect(app.noteInList(T1)).toBeVisible()`.
4. `4. one web sync and one headless sync: the note as created`:
   - `cycle('create')`;
   - `ids = notesTitled(dataApi, T1)`, polled until exactly one: `expect.poll(() => notesTitled(dataApi, T1).map(n => n.id), { timeout: 60_000, intervals: [1_000] })` has length 1; keep `id`;
   - `expect.poll(() => readNote(id), { timeout: 60_000 }).toEqual({ id, title: T1, body: B1, parent_id: seedFolderId, is_todo: 0, deleted_time: 0, is_conflict: 0, encryption_applied: 0 })`;
   - server: `serverItemContent(stack, e2eeAccount, \`${id}.md\`)` has status 200, matches `/^encryption_applied: 1$/m`, and `text.includes(run)` is `false` (`'the web app uploaded the note encrypted'`);
   - `foldersTitled(get, target)` has length 1 with `parent_id ''`; keep `targetId`.
5. `5. edit the title and the body, typed like a user`:
   - `app.openNote(T1)`, `n.waitOpen()`;
   - `n.typeTitle(T2, { replace: true })`, `n.typeBody(B2, { replace: true })`;
   - `app.backToList()`;
   - `expect(app.noteInList(T2)).toBeVisible()`, and `expect(app.noteInList(T1)).toHaveCount(0)`.
6. `6. cycle: the same note, edited`:
   - `cycle('edit')`;
   - poll `readNote(id)` toEqual `{ …, title: T2, body: B2, parent_id: seedFolderId, … }`;
   - `notesTitled(dataApi, T1)` is `[]`;
   - `notesTitled(dataApi, T2).map(n => n.id)` equals `[id]`.
7. `7. move it to the target notebook`:
   - `app.openNote(T2)`, `n.moveTo(e2eeAccount.folder!, target)`;
   - `app.backToList()`;
   - `app.openFolder(target)`;
   - `expect(app.noteInList(T2)).toBeVisible()`.
8. `8. cycle: the note in the target notebook, nothing else changed`:
   - `cycle('move')`;
   - poll `readNote(id)` toEqual `{ …, title: T2, body: B2, parent_id: targetId, … }`;
   - `notesTitled(dataApi, T2)` ids equal `[id]`.
9. `9. delete it to the trash`:
   - `app.openNote(T2)`;
   - `deletedAt = Date.now()`;
   - `n.deleteToTrash()`;
   - `app.backToList()`;
   - `expect.poll(() => app.noteInList(T2).count(), { timeout: 30_000 }).toBe(0)`.
10. `10. cycle: the note in the trash`:
    - `cycle('delete')`;
    - poll `readNote(id)` until `deleted_time > 0`: the probe returns `'trashed'` or `` `deleted_time ${v}` ``, with a 60 s timeout;
    - then `readNote(id)` matches `{ title: T2, body: B2, parent_id: targetId, is_conflict: 0 }`, with `deleted_time` between `deletedAt - 60_000` and `Date.now() + 60_000`;
    - `notesTitled(dataApi, T2)` is `[]` (not listed without `include_deleted`);
    - `notesTitled(dataApi, T2, { includeDeleted: true }).map(n => n.id)` equals `[id]`.
11. `11. network policy`: `violationLines(classifyRequests(webNetwork.entries(), origin))` equals `[]`, and no URL starts with `joplinServer.url`. The fixture checks again at teardown.

**Commit:** `test(e2e): M2-AC3 notes created, edited, moved and trashed in the web UI, checked in the headless REST API`.

## WO-13: `tests/e2e/m2-s2/notebooks-tags.spec.ts` (M2-AC4)
**Setup:**
- as WO-12, plus `test.use({ e2eeSeed: { notes: 1, extras: true } })`;
- `P = \`Notestead parent ${run}\``, `P2 = \`Notestead renamed parent ${run}\``, `C = \`Notestead child ${run}\``;
- `A = \`nst-a-${run}\``, `B = \`nst-b-${run}\``, `B2 = \`nst-b-renamed-${run}\``;
- `seedTag = e2eeAccount.seedTagTitle!`, `note1 = e2eeAccount.notes![0]`.

**`M2-AC4 notebooks created, renamed and nested, and tags added, removed and renamed in the web UI are reflected in /folders, /tags and /tags/:id/notes`:**
0. `0. data level before: note 1 carries only the device's seed tag`: `noteTagTitles(get, note1.id)` equals `[seedTag]`; keep `seedTagId` from `tagsTitled(get, seedTag)` (length 1).
1. `1. open the web app and unlock it` (as WO-12).
2. `2. create two notebooks`: `app.createNotebook(P)`, then `app.createNotebook(C)`.
3. `3. add two tags to note 1`:
   - `app.openFolder(e2eeAccount.folder!)`, `app.openNote(note1.title)`;
   - `d = await n.openTags()`;
   - `d.addNew(A)`, `d.addNew(B)`, `d.apply()`;
   - `app.backToList()`.
4. `4. cycle: the notebooks and the tags as created` (`cycle('create')`):
   - `foldersTitled(get, P)` and `foldersTitled(get, C)` each have length 1, with `parent_id ''`; keep `pId` and `cId`;
   - `tagsTitled` of A, of B and of `seedTag` each have length 1; keep `aId` and `bId`;
   - `tagNoteIds(get, aId)` and `tagNoteIds(get, bId)` equal `[note1.id]`;
   - `noteTagTitles(get, note1.id)` equals `[A, B, seedTag].sort()`.

   Wrap the first read in `expect.poll(…, { timeout: 60_000 })` as in WO-12.
5. `5. rename the parent, nest the child, remove one tag and rename the other`:
   - `f = await app.editNotebook(P)`, `f.rename(P2)`, `f.save()`, `expect(app.notesHeading(P2)).toBeVisible()`;
   - `f = await app.editNotebook(C)`, `f.setParent('Select parent notebook', P2)`, `f.save()`;
   - UI check of the nesting: `app.openSidebar()`, `app.expandFolder(P2).click()`, `expect(app.folderInSideMenu(C, 1)).toBeVisible()`, `app.closeSidebar()`. If the side menu can't be closed here, follow upstream: it closes when a notebook is opened, so `app.openFolder(C, 1)` is an accepted alternative. Record which you used;
   - `app.openFolder(e2eeAccount.folder!)`, `app.openNote(note1.title)`, `d = await n.openTags()`, `d.remove(A)`, `d.apply()`, `app.backToList()`;
   - `s = await app.openTagsScreen()`, `s.rename(B, B2)`;
   - go back to the note list: the `Back` button, then `app.sidebarButton().waitFor()`.
6. `6. cycle: the same ids renamed and nested; tag A off note 1; the device's tag untouched` (`cycle('change')`):
   - poll `allItems(get, '/folders', 'id,title,parent_id')` filtered to the ids `pId` and `cId`, until it equals `[{ id: pId, title: P2, parent_id: '' }, { id: cId, title: C, parent_id: pId }]` (sort by title);
   - `foldersTitled(get, P)` is `[]`;
   - `tagNoteIds(get, aId)` is `[]`;
   - `tagsTitled(get, B)` is `[]`;
   - `tagsTitled(get, B2).map(t => t.id)` equals `[bId]`, and `tagNoteIds(get, bId)` equals `[note1.id]`;
   - `tagsTitled(get, seedTag).map(t => t.id)` equals `[seedTagId]`, and `tagNoteIds(get, seedTagId)` equals `[note1.id]`;
   - `noteTagTitles(get, note1.id)` equals `[B2, seedTag].sort()`.
7. `7. network policy`, as WO-12 step 11.

**Commit:** `test(e2e): M2-AC4 notebooks and tags changed in the web UI, checked in /folders, /tags and /tags/:id/notes`.

## WO-14: `tests/e2e/m2-s2/todos.spec.ts` (M2-AC5 and its NEG)
**Setup:**
- as WO-12 (`e2eeSeed` default);
- `TD = \`Notestead web todo ${run}\``;
- the first statement after `requireUpstreamBundle` is `await installNotificationSpy(webApp.context)`, before any navigation.

**`M2-AC5 a to-do created in the web UI with a due date has is_todo and the due epoch under Europe/Amsterdam in the REST API, marking it done sets todo_completed, and (NEG, L1) no notification is shown at the due time`:**
0. `0. the page runs in Europe/Amsterdam`:
   - `seedFolderId` as WO-12 step 0;
   - `openUnlockedWebApp(…)`;
   - `expect(await webApp.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(userTimeZone)`;
   - `first = await readNotificationSpy(webApp.page)`;
   - `first.main` matches `{ installed: true, constructed: 0, requested: 0, shown: 0 }`; keep `docId = first.main.docId`.
1. `1. create the to-do in the seeded notebook, typed like a user`:
   - `app.openFolder(e2eeAccount.folder!)`;
   - `n = await app.newTodo()`, `n.typeTitle(TD)`;
   - `app.backToList()`;
   - `expect(app.todoCheckbox(TD)).toHaveAttribute('aria-checked', 'false')`.
2. `2. set the due date and save it: upstream's web warning`:
   - `app.openNote(TD)`, `a = await n.openAlarm()`;
   - `due = nextWholeMinute(Date.now(), 150_000)`, `parts = partsIn(due, userTimeZone)`;
   - `a.enterLocal(parts)`;
   - `expect(due - Date.now(), 'at least a minute before the due time when it is saved').toBeGreaterThan(60_000)`;
   - `expect(await a.save()).toBe('Warning: The due-date has been saved, but showing notifications is not supported by Joplin Web.')`;
   - `app.backToList()`.
3. `3. cycle: is_todo and the due epoch`:
   - `cycle('create')`;
   - `id` = the single id of `notesTitled(dataApi, TD)` (polled as WO-12);
   - poll `pick(ok(dataApi.get(\`/notes/${id}?fields=id,is_todo,todo_due,todo_completed,parent_id\`)), …)` toEqual `{ id, is_todo: 1, todo_due: due, todo_completed: 0, parent_id: seedFolderId }`.
4. `4. NEG (L1): no notification from load until 30 s after the due time` (D6):
   - `const end = due + 30_000;`
   - `await holdsFor('no Notification at or after the due time', probe, { windowMs: Math.max(0, end - Date.now()), intervalMs: 1_000 })`. The probe:
     - `r = await readNotificationSpy(webApp.page)`;
     - `!r.main` → `'the spy is not installed in the main frame'`;
     - `r.main.docId !== docId` → `'the page was reloaded, so the spy restarted'`;
     - `r.constructed + r.requested + r.shown > 0` → `` `notification API used: constructed ${r.constructed}, requested ${r.requested}, shown ${r.shown}` ``;
     - else `undefined`;
   - then `expect(Date.now(), 'the window ended after the due time').toBeGreaterThanOrEqual(end)`;
   - **positive control:** `webApp.page.evaluate(() => { const N = (globalThis as unknown as { Notification: new (t: string) => unknown }).Notification; void new N('nst-spy-control'); })`, then `(await readNotificationSpy(webApp.page)).main?.constructed` is `1`.
5. `5. mark it done in the note list`:
   - `doneAt = Date.now()`;
   - `app.todoCheckbox(TD).click()`;
   - `expect(app.todoCheckbox(TD)).toHaveAttribute('aria-checked', 'true')`.
6. `6. cycle: todo_completed is set`:
   - `cycle('done')`;
   - poll the same read until `todo_completed > 0` (a verdict probe, 60 s);
   - then `is_todo` is 1, `todo_due` is still `due`, and `todo_completed` is between `doneAt - 60_000` and `Date.now() + 60_000`.
7. `7. network policy`, as WO-12 step 11.

**Commit:** `test(e2e): M2-AC5 to-do due date as an Amsterdam epoch, done state, and no notification at the due time (L1)`.

## WO-15: Strategy update (`docs(testing)`)
`docs/testing/strategy.md`, one commit with what WO-1, WO-2 and WO-5 did not add:
- **§4, the fixtures paragraph:**
  - `webTimezone` (default `Europe/Amsterdam`);
  - `e2eeSeed: { notes, extras }`: with extras, a to-do with `todo_due = seedTodoDue`, the tag `nst-seed-<tag>` on note 1, and a text attachment on a note of its own; validated by `M2-S2-SEED-01`;
  - `webNetwork.allow(prefix)`, and the policy over the whole test checked at teardown (C2);
  - `installNotificationSpy`.
- **§5 Rules:**
  - "**One web sync, one headless sync** (from M2-S2): `syncWebOnce` waits for idle, presses `Synchronise` once, and is done on a `delta` request after the press plus an idle, error-free report. `syncHeadlessOnce` restarts the test's **own** headless service, never a shared one, so it is not disruptive under the serial rule."
  - "**REST data checks see conflicts and the trash**: list queries go through `tests/e2e/support/restQueries.ts`, which asks for `include_conflicts=1` (CLI 3.7.1 hides conflicts by default; M2-S2 F1)."
  - "**Wall-clock values** are computed with `Intl` and an explicit `timeZone`, never from the host's zone (M2-S2 D5)."
- **§3 Tooling**, the "Absence over a window" bullet: add the M2-AC5 example (the window anchored to a due time; `page.clock` not used, because it changes the app under test).

**Commit:** `docs(testing): strategy for the M2-S2 harness (sync cycles, seed extras, timezone, notification spy)`.

## WO-16: C-N2 closure (no commit)
Confirm that `tests/e2e/m2-s1/e2ee-unlock.spec.ts` step `6.` opens every seeded note after the unlock and checks its seeded body in `frameText()` (after WO-3, a value-free `'shown'` verdict). Record in §Results: "C-N2: CLOSED, covered by M2-AC2 step 6; no commit." If the step does not do that, stop and report.

## WO-17: Runs and sensitivity
Run these in order, one at a time. Logs go under `test-results/verify/m2-s2/`.
1. `T=10m run verify/lint.log corepack yarn lint`. Must be exit 0.
2. `T=15m run verify/jest-harness.log corepack yarn jest tests/unit/harness tests/integration/harness`. Must be exit 0. List the new IDs (`seed-*`, `net-13…15`, `rest-*`, `due-*`, `clear-*`) and the totals.
3. Acceptance regression:
   - `T=10m run verify/acceptance-serial.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s1/serial-rule.test.mts`: SER-04 must pass, with the three new specs scanned;
   - `T=10m run verify/acceptance-ac22.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts`: spec coverage per runner.
4. `T=120m run verify/e2e-full.log env $IMG corepack yarn playwright test`, in the background. Expected, everything passes:
   - `C1-R1-guard`;
   - `M1-AC21` and its NEG (F1 regression);
   - `M2-AC1` and its NEG (C2 regression);
   - `M2-AC2` and its NEG (C1 and F1 regression);
   - `M2-S2-SEED-01`, `M2-S2-SPY-01…03`;
   - `M2-AC3`, `M2-AC4`, `M2-AC5`.

   Copy the `cycle` annotations of the three AC tests from the HTML or JSON report into the plan. Analyse a failure; never retry blindly:
   - a harness bug is fixed test-first in a new `test(...)` commit;
   - an upstream difference is reported to the planner.
5. **Sensitivity runs.** Make temporary local edits, never committed. After each one, `git checkout -- <file>`, and `git status` must be clean for that file. Use `-g "<test ID>"`, reuse the images, and set `T=40m`.

   | Run | Edit | Must fail at |
   |---|---|---|
   | **S1** | `notes.spec.ts` step 6: drop the web sync, so call `syncHeadlessOnce(stack, headlessService)` instead of `cycle('edit')` | the step-6 `readNote` poll: `title` received T1 |
   | **S2** | `notes.spec.ts` step 9: remove `n.deleteToTrash()` and the list-count poll | step 10, the `deleted_time` verdict (`deleted_time 0`) |
   | **S3** | `notebooks-tags.spec.ts` step 5: remove the `editNotebook(C)` / `setParent` / `save` lines and the UI nesting check | step 6, the folders poll: C's `parent_id` received `''` |
   | **S4** | `notebooks-tags.spec.ts` step 5: remove the `d.remove(A)` call (keep `d.apply()`) | step 6: `tagNoteIds(aId)` received `[note1.id]` |
   | **S5** | `todos.spec.ts`: `test.use({ webTimezone: 'UTC' })`, and comment out step 0's `Intl` assertion | step 3: `todo_due` differs from `due` by a whole number of hours (record the difference) |
   | **S6** | `todos.spec.ts` step 2, right after `a.save()`: `await webApp.page.evaluate(ms => { globalThis.setTimeout(() => { void new Notification('planted'); }, ms); }, due + 5_000 - Date.now())` (casts as needed; this edit is never linted or committed) | step 4's window: `notification API used: constructed 1 …` |
   | **S7** | `sync-through-proxy.spec.ts` step 7: remove `webNetwork.allow(...)` | M2-AC1, in fixture teardown: `network policy over the whole test …` naming `GET https://notestead-control.invalid/m2-ac1` |

   For each failing run, check that `network.log`, `browser-console.log`, `server.log`, `supervisor.log` and `trace` were attached (S7 attaches `network.log` because of the teardown violation).
6. Integrity:
   - `git log --format='%h %an %s%n%b' 7b19554..HEAD -- tests/ playwright.config.ts` must list only `Agent: qa-specialist` commits;
   - every RED commit (WO-3, WO-5 to WO-10) must come before its GREEN commit.
7. Podman:
   - save `podman-after.txt` the same way as the before file, and compare;
   - only `byparr`'s resources and the kept test images may remain;
   - remove the kept images only after the planner's review, and only images with the label `io.github.thescriptingguy.notestead.test` (check with `podman image inspect --format '{{index .Labels "io.github.thescriptingguy.notestead.test"}}'` first).

## WO-18: Plan sections and report (`docs(test-plans)`)
Append to `docs/test-plans/M2-S2.md`, in the M2-S1 format:
- `## RED (… Pi arm64)`:
  - one row per RED commit (WO-3, WO-5 to WO-10): command, failure reason, log;
  - one row for the AC specs: "not a RED run (unmodified upstream); evidence: S1 to S7".
- `## Harness validation (… Pi arm64)`: S1 to S7 with their failure lines and logs.
- `## Results (QA executor, … Pi arm64)`:
  - a **Layers** table: lint, Jest, the acceptance regression, E2E full, each with duration and log;
  - a **Per criterion** table with PASS/FAIL, command, duration and evidence for: M2-AC3; M2-AC4; M2-AC5; M2-AC5 NEG; seed extras; F1; C1; C2; C5; C-N2 (closed); P1; P2; due-date; `clearLikeUser`; and the regression of M1-AC21, M2-AC1 and M2-AC2;
  - the **cycle durations** per test;
  - **Test integrity**;
  - **Podman** before and after.

  Leave x64 as PENDING-CI.

**Commit:** `docs(test-plans): M2-S2 RED, harness validation and arm64 results`.

**Report to the orchestrator:**
- the commit hashes per WO;
- the per-criterion status;
- the sensitivity outcomes;
- any stop/report item (F6, F7, the resource names, a leftover stack);
- the podman before/after result.

---

## Addendum (planner, 2026-10-21): WO-19 to WO-22, after the review of `d1963d9`
These orders implement the planner's decisions on O1, O2 and F8 (plan §Planner review and decisions). Every rule above still holds. **No test image is kept right now**, so the first heavy run rebuilds them: add `NOTESTEAD_KEEP_IMAGE=1` and leave out `$IMG`. Later runs use `$IMG`. Remove the kept images only after the planner's sign-off.

## WO-19: M2-AC4 collapse-and-expand check, and note 1 untouched (one commit)
File: `tests/e2e/m2-s2/notebooks-tags.spec.ts`.
1. **Step `0.`:** also keep `note1Before = pick(ok(dataApi.get(\`/notes/${note1.id}?fields=id,title,body,parent_id\`), 'GET note 1'), ['id', 'title', 'body', 'parent_id'])`.
2. **Step `5.`:** replace the three lines between `app.openSidebar()` and `app.closeSidebar()` with:
   ```ts
   const toggle = app.expandFolder(P2);
   await expect(toggle, 'the parent notebook starts expanded').toHaveAttribute('aria-pressed', 'true');
   await expect(app.folderInSideMenu(C, 1), 'the child shows at level 1 under the expanded parent').toBeVisible();
   await toggle.click();
   await expect(toggle, 'collapsed').toHaveAttribute('aria-pressed', 'false');
   await expect(app.folderInSideMenu(C, 1), 'the child is hidden under the collapsed parent').toHaveCount(0);
   await toggle.click();
   await expect(toggle, 'expanded again').toHaveAttribute('aria-pressed', 'true');
   await expect(app.folderInSideMenu(C, 1)).toBeVisible();
   ```
   Keep the comment above them, and extend it by one line: `// The collapse shows the level-1 child belongs to this parent (plan §Planner review, O2).`
   - If the child stays visible while collapsed, or the toggle's name changes with its state, stop and report the `ariaSnapshot()` of the side menu.
   - Don't drop the assertion.
3. **Step `6.`:** add at the end `expect(pick(ok(dataApi.get(\`/notes/${note1.id}?fields=id,title,body,parent_id\`), 'GET note 1'), ['id', 'title', 'body', 'parent_id']), 'note 1 itself is unchanged: the web app changed only its tags').toEqual(note1Before)`.
4. **Run** (first run of the addendum, so it rebuilds the images): `T=60m run test-results/verify/m2-s2/green/wo19-notebooks-tags.log env NOTESTEAD_KEEP_IMAGE=1 corepack yarn playwright test tests/e2e/m2-s2/notebooks-tags.spec.ts`. It must pass.
   - If the note-1 check fails, stop and report the diff. A changed body points to the F8 focus spill, and that is a harness bug to fix test-first.

**Commit:** `test(e2e): M2-AC4 collapses and expands the parent notebook, and checks note 1 is unchanged (O2)`.

## WO-20: Sensitivity runs S1c and S1d (no commit)
Make temporary edits to `tests/e2e/m2-s2/notes.spec.ts`. After each run, `git checkout -- tests/e2e/m2-s2/notes.spec.ts`, and `git status` must be clean. Use `env $IMG`, `T=40m` and `-g "M2-AC3"`.

| Run | Edit | Must fail at |
|---|---|---|
| **S1c** | step `6.`: put `await webApp.context.setOffline(true);` before `await cycle('edit');` | in `syncWebOnce` (step 6): `Expected: "completed"`, with `Received` either `"no delta request since the press"` or `"the sync reported an error: …"`. Record which |
| **S1d** | step `5.`: put `await webApp.context.setOffline(true);` before `await app.openNote(T1);`. Step `6.`: replace `await cycle('edit');` with `await syncHeadlessOnce(stack, headlessService);` (import it from `../../stack/stack.ts`) | the step-6 `readNote` poll: `title` and `body` received T1 and B1 |

- **If S1d does not fail:** search its `network.log` for a `PUT` of `…/<note id>.md` stamped after the `setOffline` call (`grep` the timestamps), and report what you find. It tells us whether requests from a service worker or worker bypass `setOffline`. Don't try other seams.
- **For both runs:** check that `network.log`, `browser-console.log`, `trace`, `server.log` and `supervisor.log` are attached.

## WO-21: Strategy note for the focus stabilisation (`docs(testing)`)
In `docs/testing/strategy.md` §3, extend the "Absence over a window" bullet by one sentence:

> A **stabilisation** is the same rule at a small scale: "nothing changes for N polls" after an observed event, such as the note editor's load before typing a new note's title (`NoteScreen.waitSettled`, 10 × 100 ms; M2-S2 F8).

**Commit:** `docs(testing): a short stabilisation window anchored to an event is an absence window (M2-S2 F8)`.

## WO-22: Plan update and report (`docs(test-plans)`)
`docs/test-plans/M2-S2.md`:
- **§Harness validation:**
  - mark the S1 row **superseded (O1, F9)**;
  - keep S1b;
  - add S1c and S1d with their failure lines and logs.
- **§Results, Per criterion:** replace the M2-AC4 row with the WO-19 run (PASS/FAIL, command, duration, log). Mention the collapse step and the note-1 check.
- **§Results, Podman:** add the before/after state of the addendum runs, including which images were kept and removed. Remove them only after the planner signs off.
- **§Test integrity:** re-run `git log --format='%h %an %s%n%b' 7b19554..HEAD -- tests/ playwright.config.ts`.
- **Don't** write a sign-off line; the planner records it after review.

**Commit:** `docs(test-plans): M2-S2 addendum results (collapse step, S1c, S1d)`.

**Report to the orchestrator:**
- the commit hashes;
- the WO-19 result;
- S1c's `Received` value;
- S1d's outcome (and, if it did not fail, the `network.log` finding);
- the podman state.
