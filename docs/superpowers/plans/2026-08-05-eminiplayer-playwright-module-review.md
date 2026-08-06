# Review: EminiPlayer Playwright Module — Spec + Plan

**Date:** 2026-08-05
**Reviewed:** `docs/superpowers/specs/2026-08-05-eminiplayer-playwright-module-design.md` (spec) and `docs/superpowers/plans/2026-08-05-eminiplayer-playwright-module.md` (plan)
**Method:** Four parallel adversarial critics (spec-plan consistency, internal plan correctness, architecture soundness, codebase grounding), findings deduped and scored per the severity rubric (Critical −3, High −2, Medium −1, Low −0.5, per-doc, clamped at 1). Feature is **not yet built** — this is forward-looking bug risk.

**Resolution (2026-08-05): all 14 findings APPLIED** to the spec and plan at the user's request. Where a finding offered options: #9 was resolved by adding an approving spec line for the AppModule registration (the smoke test needs it); #6 by prefixing the smoke test with `BENCHMARK_SCHEDULER=false` plus an ADC-prerequisite note; #3 by a `withPage()` promise-chain mutex in `PlaywrightService` (subsuming the lazy-launch race); #11 by `__dirname` anchoring. The scores below describe the documents **as reviewed**, before these fixes.

## Scores

| Doc | Score | Rationale |
|---|---|---|
| Spec | **5 / 10** | Two Highs (login flow contradicts verified site behavior; no concurrency contract for the shared page) plus one Medium (PlaywrightService ownership/boundary unstated). |
| Plan | **2 / 10** | One High (browser-crash permanently poisons the singleton) + two Mediums + eight verified Lows. Note the low score is *accumulation*, not rot: the grounding and internal-correctness lenses found **zero** identifier drift, zero placeholders, every cited file/API verified against the real repo and playwright 1.62.1, and every test/implementation pair mentally executes to pass. The deductions are concentrated in the runtime design (Task 2/3 code) and the Task 4 verification steps. |

What was verified clean (so it isn't re-litigated): `pnpm test -- <pattern>` works (empirically run); `jest.mock('node:fs/promises')` and mock-before-import patterns match repo precedent; all Playwright APIs exist in 1.62.1; CommonJS smoke-test `require()` pattern works; ts-node resolves; config/appmodule modification anchors are exact; e2e specs don't collide with the unit testRegex; out-of-scope items (parsing, endpoints, retries, persistence) are not reintroduced anywhere.

---

## Findings

### High

**1. [spec — `openArchivePage()` flow steps 3–4 + Testing] Spec's login-detection flow is unimplementable against the verified site behavior and contradicts the plan.**
Spec says: detect a login form (username/password inputs, or login-page URL) on the page resulting from `goto(archive.aspx)`, fill it there, verify "no login form present." Verified site facts (in the plan): `archive.aspx` returns 200 when logged out with **no form** — the logged-out signal is a nav link `a[href*="login.aspx"]`, and login requires an explicit hop to `login.aspx`.
*Failure scenario:* an implementer building from the spec (the authoritative doc) finds no form on archive.aspx, skips login, verification passes, and `openArchivePage()` returns success for an **unauthenticated** page — the future parser silently scrapes logged-out content. An implementer reading both docs hits a direct contradiction and stalls.
*Fix:* rewrite spec flow steps 3–4 + Testing bullets to the link-based flow (logged-out signal = nav login link; login via explicit `login.aspx` navigation with the `ctl00_*` selectors; verify archive URL + link absent), with a dated note that the "redirect to login form" assumption was disproven 2026-08-05.

**2. [plan — Task 2 Step 3, `PlaywrightService.getPage()`] No recovery from browser/context death; one Chromium crash poisons the singleton for the life of the app.**
`browser`/`context`/`page` are cleared only in `onModuleDestroy`. If Chromium crashes (OOM, SIGKILL), `page.isClosed()` is true but `this.browser`/`this.context` are still truthy, so `getPage()` calls `newPage()` on a dead context → `TargetClosedError` on every subsequent call until app restart. Tests cover "page closed" but never "browser gone."
*Fix:* in `getPage()`, treat `!this.browser.isConnected()` as dead — clear all three refs and relaunch; add a unit test simulating a disconnected browser asserting a second `chromium.launch`.

**3. [spec — Architecture / flow step 6 (code lands in plan Tasks 2–3)] No concurrency contract for the shared mutable page; nothing makes the multi-step flow single-flight.**
One shared `Page`, injectable singleton, spec's stated purpose is multiple future consumers. Concurrent `openArchivePage()` calls interleave on the same page: caller A's verification runs after caller B's `goto(LOGIN_URL)` → spurious "expected archive.aspx" throws, fills against the wrong document, screenshots of half-filled login forms (username in cleartext). Includes the lazy-launch check-then-act race: two concurrent first calls both pass `!this.browser` and launch Chromium twice, orphaning a whole browser process that `onModuleDestroy` can never close.
*Fix:* state the contract in the spec and enforce single-flight in code — memoize the init promise in `PlaywrightService` (`this.pagePromise ??= createPage()`) and serialize page use through a promise-chain mutex; add a test that concurrent calls don't interleave and launch exactly once.

### Medium

**4. [plan — Task 3 Step 4, final URL check] `page.url().includes('archive.aspx')` passes on the most likely failure URL.**
Standard ASP.NET forms-auth redirects to `login.aspx?ReturnUrl=%2farchive.aspx` — which *contains* the substring `archive.aspx`. If the login-link heuristic ever misses (nav markup drift — it's the plan's single logged-out signal, verified against one dated snapshot), the only remaining guard passes on the login page and the service returns success with a login-page screenshot. Two weak checks whose blind spots overlap on the same scenario.
*Fix:* structural check — parse `new URL(page.url())`, require hostname `eminiplayer.net` and pathname exactly `/archive.aspx`; add a test with the ReturnUrl redirect URL.

**5. [spec — Architecture ("Knows nothing about eminiplayer.net")] PlaywrightService is framed as generic/reusable but its API hands out the process-wide singleton page — ownership is unstated.**
The moment any second consumer navigates via `getPage()`, EminiplayerService's parked page silently ends up elsewhere, and the spec-promised "future parsing methods on the still-open page" read the wrong site's DOM — silent wrong data. The module wiring even contradicts the framing (PlaywrightService isn't exported, so it's de facto private — but neither doc says so).
*Fix:* write the ownership decision down: either declare PlaywrightService module-private with a single-owner page (one spec sentence + code comment) and have parser methods re-assert the URL, or make the API ownership-safe (`newPage()` per consumer sharing one context).

**6. [plan — Task 4 Steps 6–7, smoke test] Booting the full `AppModule` fires the benchmark scheduler against real Firestore.**
Verified: `batch-reconciler.ts:38` runs `reconcile()` on `onApplicationBootstrap` when `benchmark.schedulerEnabled` is true, and `configuration.ts:101` enables it whenever `NODE_ENV !== 'test'` — which is the case under `ts-node`. Without GCP ADC the smoke test fails at boot before ever reaching `openArchivePage()` (scraper looks broken); with ADC it silently performs benchmark Firestore reads/writes as a side effect of an eminiplayer smoke test.
*Fix:* prefix the command with `BENCHMARK_SCHEDULER=false` (and note the ADC prerequisite), or bootstrap a minimal context (`ConfigModule.forRoot` + `EminiplayerModule`) instead of AppModule.

### Low

**7. [plan — Task 4 Step 5] The step warns "watch for regressions in app-level e2e specs" but never runs them.**
`pnpm test` (jest rootDir `src`, testRegex `.spec.ts$`) cannot execute `backend/test/*.e2e-spec.ts`; seven of those boot AppModule — the exact file this task modifies — and only `pnpm test:e2e` runs them.
*Fix:* change Step 5 to `pnpm test && pnpm test:e2e && pnpm build`.

**8. [plan — Task 4 Steps 6–7] Smoke-test snippet: `npx ts-node` contradicts the plan's own pnpm-only constraint, and the expected output shows a *relative* `screenshotPath` while the Task 1 config returns an absolute path (`resolve('artifacts','eminiplayer')`).**
An implementer diffing actual (absolute) output against the documented (relative) expectation may "fix" the config and break Task 1's tests.
*Fix:* `pnpm exec ts-node`, and show the absolute path form in Step 7 and the README.

**9. [plan — Task 4 Steps 3/5] Registering `EminiplayerModule` in `AppModule` is scope the spec never approved.**
Spec: "No controller, no cron — service only. Consumers inject EminiplayerService." With zero consumers, nothing needs the wiring except the smoke test; it makes every AppModule-booting e2e spec newly depend on the playwright package resolving.
*Fix:* either drop the registration (consumers import EminiplayerModule when they arrive) or add one approving line to the spec noting the smoke test is why.

**10. [plan — Task 3 Step 4] Navigation timeouts propagate raw Playwright errors without the step context the spec explicitly requires.**
A 30s `goto` timeout surfaces as bare "page.goto: Timeout 30000ms exceeded" with no indication of module or step (initial nav vs login submit vs re-nav). Spec's error-handling section promises step context.
*Fix:* wrap the navigation awaits in try/catch that rethrows with a step-named prefix, or amend the spec to accept Playwright's native messages.

**11. [plan — Task 1 Step 4] `screenshotDir` default anchored to `process.cwd()`, not `__dirname`.**
The repo's own config avoids exactly this for `benchmark.repoRoot` (configuration.ts:87). Booted from the repo root, screenshots of authenticated members-area content land in `<repo-root>/artifacts/`, which the root `.gitignore` does not cover — sensitive artifacts become committable.
*Fix:* `resolve(__dirname, '..', '..', 'artifacts', 'eminiplayer')` (matching the benchmark convention), or also gitignore `artifacts/` at the root.

**12. [plan — Task 4 Step 1] Module spec omits `ignoreEnvFile: true`, against repo convention (anthropic/moonshot module specs both set it).**
After Step 7 puts real credentials in `backend/.env`, every future unit-test run of this spec silently loads live credentials into `process.env`.
*Fix:* add `ignoreEnvFile: true` to the `ConfigModule.forRoot` options in the module spec.

**13. [plan — Task 1 Step 3] Expected red state is misdescribed.**
`cfg.eminiplayer` against the current `AppConfig` is a hard TS2339 compile error under ts-jest — the *whole* configuration spec file fails to compile, including the 14 pre-existing tests — not a runtime "undefined" assertion. An implementer may misread the wall of compile errors as having broken the existing suite.
*Fix:* state the TS2339 whole-suite compile failure as the expected outcome.

**14. [plan — Task 3 Step 4] `page.waitForNavigation` is `@deprecated` in playwright 1.62.1 ("inherently racy, please use waitForURL") — on exactly the login-postback race this code cares about.**
Works today; builds a brand-new module on an API Playwright is steering away from.
*Fix:* `Promise.all([page.waitForURL(u => !u.href.includes('login.aspx'), { waitUntil: 'domcontentloaded' }), page.click(...)])`.

---

## Deduction ledger

- **Spec:** #1 High (−2), #3 High (−2), #5 Medium (−1) → **5**
- **Plan:** #2 High (−2), #4 Medium (−1), #6 Medium (−1), #7–#14 eight Lows (−4) → **2**

Findings #1/#3/#5 are charged to the spec and #2/#4/#6–#14 to the plan; where an issue spans both docs it is charged once, to the doc that owns the decision.
