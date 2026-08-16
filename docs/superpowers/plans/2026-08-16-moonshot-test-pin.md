# Moonshot Test Pin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin `LLM_PROVIDER=moonshot` for the entire test suite (unit + e2e) and make the e2e benchmark suites mock the Moonshot client, so tests always exercise the production provider path and can never reach a real API regardless of what `backend/.env` contains.

**Architecture:** A jest `setupFiles` script sets the pinned env before anything loads (process.env wins over Nest's dotenv, so `.env` becomes irrelevant to tests in both directions — provider choice AND the real API key). The two benchmark e2e suites swap their `jest.mock('@anthropic-ai/sdk')` for `jest.mock('openai')`, faking the OpenAI-compatible surface `MoonshotLlmProvider` actually calls, and drive model alias `k3` (kimi-k3) instead of `fable` since aliases resolve to raw ids with no provider gating.

**Tech Stack:** Jest 29, NestJS 10, `openai` v4 SDK (mocked). No new dependencies.

**Spec:** No separate spec doc — the four-point design was approved in-chat (pin both configs; convert both benchmark e2e mocks to the moonshot surface; switch those suites to `k3`; verify hermeticity). Background hazard this fixes: with `.env` setting `LLM_PROVIDER=moonshot`, `pnpm test:e2e` made REAL Moonshot API calls because only the Anthropic SDK was mocked.

## Global Constraints

- Working dir for all commands: `/Users/nicholasstelter/Code/foster-bridge/.claude/worktrees/moonshot-test-pin/backend` (tests: `pnpm test -- <pattern>`, e2e: `pnpm test:e2e`).
- The pin must hold even when `backend/.env` exists with `LLM_PROVIDER=moonshot` and a REAL `MOONSHOT_API_KEY`: tests must see `LLM_PROVIDER=moonshot` and `MOONSHOT_API_KEY=test-key` (dummy). Nest's ConfigModule/dotenv never overrides pre-set `process.env` — the setup file runs first.
- Do NOT weaken any existing assertion. Test-only changes plus jest config; zero production-code changes.
- Semantic commit messages; NO attribution lines/footers/Co-Authored-By in commits.

## Verified mock-surface contracts (from backend/src/moonshot/moonshot.service.ts + moonshot.chat.ts)

The implementer converts mocks against THESE shapes (re-read the cited code before writing the mock — do not guess beyond this):

- **Submit (native batch path — the default; `getBatchResults` only takes the emulated branch for ids starting with the synthetic `EMULATED_BATCH_ID_PREFIX`, which real submissions via `client.batches.create` never produce):**
  - `toFile(payload, 'batch.jsonl', {type})` — from the `openai` package root export, must exist in the mock's module exports.
  - `client.files.create({ file, purpose: 'batch' })` → `{ id: 'file_e2e' }`.
  - `client.batches.create({ input_file_id, endpoint, completion_window })` → `{ id: 'batch_e2e', status: 'validating' }` (any non-terminal status; `toLifecycle`: validating/in_progress/finalizing → `in_progress`).
- **Poll:** `client.batches.retrieve(batchId)` → `{ id, status: batchState.status, request_counts: {}, output_file_id: 'out_e2e' }` where the test's `batchState.status` toggles `'in_progress'` → `'completed'` (`completed` maps to lifecycle `ended`).
- **Results:** `client.files.content('out_e2e')` → `{ text: async () => jsonlString }`. Each JSONL line:
  `{ "custom_id": "<cell id>", "response": { "status_code": 200, "body": { "choices": [{ "message": { "content": "<JSON setup string>" }, "finish_reason": "stop" }], "usage": { "prompt_tokens": 10, "completion_tokens": 5, "cached_tokens": 10 } } } }`
  (`toItemResult` requires status_code 200 + body; `toChatResult` reads `choices[0].message.content` and `finish_reason` — `'stop'` = success; content must START with `{` — moonshot.chat.ts:206-210 has a brace-repair hack that would mangle non-JSON.)
- **Terminal-batch input-file GC:** after a terminal retrieve, `nativeResults` calls `files.content` then `client.files.del(input_file_id)` quietly IF `batch.input_file_id` is set — simplest mock: omit `input_file_id` from the retrieve payload, or provide a resolving `files.del`. Provide `files.del: jest.fn().mockResolvedValue({})` either way.
- **Sync chat (KEYS generation, warms):** `client.chat.completions.create(params)` where structured calls carry `params.response_format` (from `jsonSchemaFormat(schema)` — shape `{ type: 'json_schema', json_schema: { schema, ... } }`; read `jsonSchemaFormat` in moonshot.chat.ts for the exact nesting before keying off it). Return `{ choices: [{ message: { content: JSON.stringify(structuredFor(schema)) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 0 }, model: 'kimi-k3' }`. Non-structured calls (cache warm) return the same shape with empty-object content `'{}'` (content must start with `{`). Read `backend/src/benchmark/cache-warmer.ts` first to see exactly what the moonshot warm path calls and expects.
- **Error type:** `moonshot.service.ts`'s `rethrow` distinguishes `OpenAI.APIError` — the mock ctor must expose a static `APIError` class (mirror the existing `FakeAPIError` pattern).
- **Model alias:** `resolveModel('k3')` → `{ alias: 'k3', id: 'kimi-k3' }` (benchmark.types.ts:131-152). Cell ids become `context-trader__k3__07012026__<variant>__run<N>`.

---

### Task 1: Jest env pin for both suites

**Files:**
- Create: `backend/test/set-test-env.ts`
- Modify: `backend/jest.config.js` (add `setupFiles`)
- Modify: `backend/test/jest-e2e.json` (add `setupFiles`)
- Possibly modify: `backend/src/config/configuration.spec.ts` (if it asserts provider defaults without clearing `LLM_PROVIDER` — clear it in that spec's env reset, test-locally)

**Interfaces:**
- Produces: every jest worker (unit and e2e) starts with `process.env.LLM_PROVIDER = 'moonshot'`, `process.env.MOONSHOT_API_KEY = 'test-key'` set before any module loads. Tasks 2-3 rely on the e2e provider being moonshot.

- [ ] **Step 1: Write the setup file**

`backend/test/set-test-env.ts`:

```typescript
// Runs (via jest setupFiles) before any test module loads, in every worker.
// Pins the LLM seam so tests always exercise the Moonshot provider path and
// a developer's real backend/.env can neither flip the provider nor leak a
// real API key into a test process: Nest's ConfigModule/dotenv never
// overrides variables that are already set on process.env.
process.env.LLM_PROVIDER = 'moonshot';
process.env.MOONSHOT_API_KEY = 'test-key';
```

- [ ] **Step 2: Wire it into both configs**

In `backend/jest.config.js` add to the exported config (path is relative to that config's `rootDir: 'src'` — use `<rootDir>/../test/set-test-env.ts`):

```javascript
setupFiles: ['<rootDir>/../test/set-test-env.ts'],
```

In `backend/test/jest-e2e.json` (its rootDir is the `test` dir — check the file and use the matching relative form, e.g. `<rootDir>/set-test-env.ts`):

```json
"setupFiles": ["<rootDir>/set-test-env.ts"]
```

Read each config first and place the key alongside its existing options; if `ts-jest` doesn't transform plain setup files listed this way, rename to `set-test-env.js` with the same two lines minus types — whichever runs cleanly.

- [ ] **Step 3: Run the unit suite and repair env-sensitive specs test-locally**

Run: `pnpm test`
Expected: mostly green. Known risk: `src/config/configuration.spec.ts` resets env vars before asserting defaults — if it now sees the pinned `LLM_PROVIDER`/`MOONSHOT_API_KEY` where it expects unset, add those two to the vars it deletes/restores in its own setup (a test-local fix; do not touch the setup file for this). Similarly for any other spec that asserts a default depends on an unset var. Do not weaken assertions — clear the pinned vars in those specs' own env-reset blocks.

- [ ] **Step 4: Run the e2e suite — expected partial failure**

Run: `pnpm test:e2e`
Expected: the two benchmark suites now FAIL (provider is moonshot; their mocks are still anthropic-only — Tasks 2-3 fix that; with `MOONSHOT_API_KEY=test-key` any escaped HTTP call 401s instead of spending real money, which is the pin doing its job). The other seven suites must PASS. If any of the other seven fails, that's a real finding — investigate before proceeding.

- [ ] **Step 5: Commit**

```bash
git add test/set-test-env.ts jest.config.js test/jest-e2e.json src/config/configuration.spec.ts
git commit -m "test: pin LLM provider to moonshot with a dummy key across all jest suites"
```

(Include `configuration.spec.ts` only if Step 3 touched it.)

---

### Task 2: Convert benchmark.e2e-spec.ts to the Moonshot mock at model k3

**Files:**
- Modify: `backend/test/benchmark.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1's pin (provider is moonshot at boot); the mock-surface contracts above.
- Produces: the suite green under the moonshot provider; Task 3 follows the same mock pattern.

- [ ] **Step 1: Read before writing**

Read, in this order: the current spec top-to-bottom; `backend/src/moonshot/moonshot.service.ts` (createBatch ~264-311, getBatchStatus ~328-335, nativeResults ~357-390, toItemResult ~395-430, toLifecycle ~465-482, rethrow); `backend/src/moonshot/moonshot.chat.ts` (`jsonSchemaFormat`, `toChatResult`, the brace-repair at ~206-210); `backend/src/benchmark/cache-warmer.ts` (what the moonshot warm calls).

- [ ] **Step 2: Replace the SDK mock**

Replace the whole `jest.mock('@anthropic-ai/sdk', ...)` block with `jest.mock('openai', ...)` implementing the contracts above. Keep the file's existing patterns: module-scope `batchState`, a `FakeAPIError`-style class exposed as the ctor's static `APIError`, shared jest.fn()s so every constructed client sees the same batch state. The mock's default export is the client constructor; also export `toFile` (async passthrough like the current one). The results JSONL must yield the two cells `context-trader__k3__07012026__base__run1` / `__run2` with the same long/short setup payloads the current mock produces (reuse the existing `succeeded(side)` helper's setup JSON as the `message.content` string).

- [ ] **Step 3: Flip the model alias and every assertion that carries it**

- `POST /benchmark/run` body: `model: 'k3'`.
- `listCells('k3')`, custom ids `context-trader__k3__...` (including the pre-seeded batch doc in the startup-recovery test: its `customIdToCell` keys and `model: { alias: 'k3', id: 'kimi-k3' }`).
- Scoreboard: `GET /benchmark/scoreboard?model=k3`, heading `'## context-trader @ k3 [base]'`.
- Candle seeding, day fixtures, backtest expectations (SL + INVALID): unchanged — they are provider-independent.

- [ ] **Step 4: Run the suite**

Run: `pnpm test:e2e -- benchmark.e2e`
Expected: PASS (both tests plus the drift-guard describe). Debug against the contracts section — the likeliest failures are JSONL row shape (status_code/body nesting) and content not starting with `{`.

- [ ] **Step 5: Commit**

```bash
git add test/benchmark.e2e-spec.ts
git commit -m "test(benchmark): e2e drives the moonshot provider with a mocked openai client"
```

---

### Task 3: Convert benchmark-scorecard.e2e-spec.ts (adds the KEYS chat path)

**Files:**
- Modify: `backend/test/benchmark-scorecard.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2's mock pattern; the sync-chat contract (structured calls keyed off `params.response_format`).
- Produces: full e2e suite green under the pin.

- [ ] **Step 1: Read before writing**

Read the current spec top-to-bottom — note its `structuredFor(schema)` helper (serves the seven-keys structured calls by schema shape) and `setup(side)` helper. Read `backend/src/benchmark/seven-keys/seven-keys.service.ts` far enough to know which provider methods the analyst/synthesizer/verifier calls go through under moonshot (they route via the same `LlmProvider` seam → `chat.completions.create` with `response_format`).

- [ ] **Step 2: Replace the SDK mock**

Same `jest.mock('openai', ...)` pattern as Task 2, with the addition: `chat.completions.create` inspects `params.response_format` — when present, extract the JSON schema exactly where `jsonSchemaFormat` nests it and return `content: JSON.stringify(structuredFor(schema))`; when absent (warm), return `content: '{}'`. Batch surface identical to Task 2 but with this suite's ids (`batch_sc`, `file_sc`, both `base` and `seven-keys-scorecard` variant cells under alias `k3`).

- [ ] **Step 3: Flip alias-carrying assertions**

- `POST /benchmark/run` body: `model: 'k3'`; `cellsQueued` expectations unchanged.
- `repo.getKeysArtifact('07012026', 'k3')` (currently `'fable'`).
- KEYS content assertions (`'# Seven Keys — ES 2026-07-01'`, `verified`, `contentHash` length) unchanged — they are model-independent; if any assertion embeds the model id, update to `kimi-k3`.
- `listCells('k3')`, scoreboard heading/group assertions to `@ k3`.

- [ ] **Step 4: Run the full e2e suite, then the full unit suite**

Run: `pnpm test:e2e` then `pnpm test`
Expected: all 9 e2e suites and the full unit suite PASS — with `backend/.env` present on disk, proving the pin makes it irrelevant.

- [ ] **Step 5: Commit**

```bash
git add test/benchmark-scorecard.e2e-spec.ts
git commit -m "test(benchmark): scorecard e2e mocks moonshot chat + batch surfaces"
```
