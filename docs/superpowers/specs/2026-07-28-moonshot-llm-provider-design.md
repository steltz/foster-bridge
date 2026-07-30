# Moonshot (Kimi K3) LLM Provider — Design Spec

*Date: 2026-07-28 (revised same day — hardening pass, decisions D5–D8). Status: approved design; plan drafted. Hardening folded into §6.1.1, §6.4, §7, §8, §9, §10.*

## 1. Goal & context

The benchmark backend (`backend/src/`) was recently refactored into a provider-neutral
port + adapter design: a neutral `LlmProvider` port (`backend/src/llm/`) with a single
concrete adapter, Anthropic (`backend/src/anthropic/`), selected by config at one swap
seam (`backend/src/llm/llm.module.ts`). This spec adds the **second** provider —
**Moonshot / Kimi**, with **`kimi-k3`** as the flagship (the Fable-equivalent).

Requirements from the requester:
- Plug-and-play with the benchmark module (no changes to benchmark/seven-keys/cost logic
  beyond the neutral seams).
- As close to the Anthropic adapter as possible in how caching and batch are used.
- Maximum efficiency: exploit both **context caching** and **batch** mechanisms, because
  we run very large volumes of benchmarks.

Source research: `docs/moonshot/api.md`, `docs/moonshot/cache.md`, plus live verification
against `platform.kimi.ai/docs` (July 2026). Base URL `https://api.moonshot.ai/v1`,
OpenAI-compatible (`openai` Node SDK via `baseURL` swap).

## 2. Decisions (resolved forks)

| # | Decision | Choice |
|---|---|---|
| D1 | Batch API implementation | Native OpenAI-compatible `/v1/batches`, **verified first** against live docs |
| D2 | Model identity across providers | **Provider-aware `flagship` alias** (Anthropic→`claude-fable-5`, Moonshot→`kimi-k3`) |
| D3 | K3 vs batch (K3 is NOT batchable) | **Hybrid adapter, K3 stays flagship**: native batch for batchable models, emulated batch for K3 |
| D4 | Emulated-batch execution model | **Durable worker + restart recovery** (Firestore-persisted, `OnApplicationBootstrap` resume) |
| D5 | Emulated multi-process safety | **Transactional item claiming** (`pending → running` with a lease) so `kick()` and bootstrap-resume never double-run an item across instances |
| D6 | Emulated stuck-batch handling | **Batch `expiresAt`** → past deadline with non-terminal items, mark the batch terminal `errored`; the reconciler re-queues those run-indices |
| D7 | Emulated cache priming | **Prefix-grouped fan-out** — group items by `prompt_cache_key`, prime one call per group before fanning it out (a single global prime warms only one of many cell prefixes) |
| D8 | Structured-output strict mode | **Provider-aware schema shaping** (`toMoonshotSchema` — all properties required, optionals nullable) + `walle` validation + a `json_object`/`partial` fallback |

*D5–D8 are a hardening pass over D3/D4's emulated path (the novel, highest-risk component); they change no external interface — only the Moonshot adapter's internals, data model, and config.*

## 3. Verified API facts (July 2026)

- **Batch endpoints exist** (OpenAI-compatible): `POST /v1/batches`, `GET /v1/batches/{id}`,
  `POST /v1/batches/{id}/cancel`, `GET /v1/batches`.
- **`kimi-k3` is NOT supported by the Batch API.** Batch supports only `kimi-k2.6`,
  `kimi-k2.7-code`, `kimi-k2.5`. This is the pivotal constraint that forces the hybrid
  design (D3): the flagship K3 must run through client-side emulation, since the benchmark
  requires `capabilities.batch === true`.
- **Batch create shape:** `input_file_id` (a `.jsonl` uploaded with `purpose:"batch"`),
  `endpoint:"/v1/chat/completions"` (field name is `endpoint`, not `url`),
  `completion_window` ∈ {`12h`,`1d`,`3d`}, min `12h`, max `7d` (**not** OpenAI's `"24h"`),
  optional `metadata`.
- **Batch input JSONL line:** `{custom_id, method:"POST", url:"/v1/chat/completions", body}`.
  Constraints: one `model` per batch; **do not include `temperature`/`top_p`** (fixed params).
- **Batch results:** batch object carries `output_file_id` + `error_file_id`; download via
  `GET /v1/files/{id}/content` as JSONL, one line per `custom_id`:
  `{id, custom_id, response:{status_code, body:{choices,usage,...}}, error}`.
- **Batch lifecycle:** `validating, in_progress, finalizing, completed, expired, failed,
  cancelling, cancelled`. `request_counts = {completed, failed, total}`.
- **Batch discount: 40% off** (batch price = 60% of standard), applied **per model**.
  There is **no K3 batch price** (K3 not batchable).
- **Structured output:** `response_format:{type:"json_schema", json_schema:{name, strict,
  schema}}` — K3 reliably supports it incl. nested/arrays/`anyOf`, `strict:true` recommended.
  MFJS safe keyword subset: `type, properties, required, additionalProperties, enum, anyOf,
  oneOf, $ref, items`. Do **not** rely on `maxLength/minLength/minimum/maximum/pattern/format/
  minItems/maxItems`. A `walle` CLI validates schemas when `strict=true`.
- **`partial:true`** trailing-assistant-message prefill supported (fallback for forcing JSON).
- **`reasoning_effort`** ∈ {`low`,`high`,`max`}, default `max`; thinking cannot be disabled on K3.
- **Caching is implicit/automatic** — no `cache_control` param, no cache object.
  `prompt_cache_key` is an optional routing hint. `usage.cached_tokens` is **top-level**
  (not nested like OpenAI's `prompt_tokens_details.cached_tokens`). Cache-hit requires the
  *previous* request's prompt to exceed **256 tokens**.
- **K3 pricing / 1M tokens:** cache-hit input **$0.30**, cache-miss input **$3.00**, output
  **$15.00**, **no cache-write surcharge**.
- **Files API:** `POST /v1/files` (`purpose` ∈ {`file-extract`,`image`,`video`,`batch`}),
  `GET /v1/files/{id}/content` (extracted text for `file-extract`; also serves batch output
  JSONL), `DELETE /v1/files/{id}`. Limits: 100 MB/file, 1,000 files, 10 GB/account.
- **SDK:** `openai` Node SDK works via `baseURL` swap. Moonshot-only fields
  (`prompt_cache_key`, `partial`, `reasoning_effort` value set, top-level `cached_tokens`)
  are not in the SDK's TS types → define thin wrapper types + `as any` at call sites.

## 4. Neutral port recap (unchanged contract to satisfy)

`backend/src/llm/llm.provider.ts` — six required members, four capabilities:

```ts
interface LlmCapabilities { batch; fileUpload; promptCaching; structuredOutput }  // all boolean
interface LlmProvider {
  readonly capabilities: LlmCapabilities;
  messageStructured<T>(req: StructuredRequest, attribution: Attribution): Promise<T>;
  uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string>;
  submitBatch(requests: BatchItemRequest[], envelope: PromptEnvelope|undefined, opts: BatchSubmitOptions): Promise<BatchHandle>;
  getBatch(batchId: string): Promise<BatchHandle>;
  getBatchResults(batchId: string): Promise<BatchItemResult[]>;
}
```

Neutral types (`backend/src/llm/llm.types.ts`): `LlmContentBlock = {type:'text',text} | {type:'file',fileId}`,
`LlmCacheTier = {blocks}`, `PromptEnvelope = {system?, tiers?}`, `StructuredRequest`,
`BatchItemRequest = {customId?, prompt, envelope?}`, `BatchSubmitOptions = {model?, schema?, maxTokens?, effort?}`,
`BatchLifecycle = 'submitted'|'in_progress'|'ended'|'canceled'|'expired'|'errored'`,
`BatchHandle = {batchId, status, requestCounts?}`,
`BatchItemResult = {customId, type:'succeeded'|'refusal'|'errored'|'canceled'|'expired'|..., text?, error?, cacheReadTokens?, usage?}`.

`UsageTokens` (`backend/src/cost/cost.types.ts`): `{input, cacheRead, cacheCreate5m, cacheCreate1h, output}`.

The benchmark's capability guard (`requireCapabilities`) requires all four capabilities for a
full run (`benchmark.service.ts:59`, `cache-warmer.ts:42`, `batch-reconciler.ts:52`). Moonshot
sets all four `true`.

## 5. Architecture — files

### New: `backend/src/moonshot/`

| File | Role |
|---|---|
| `moonshot.service.ts` | `MoonshotLlmProvider implements LlmProvider`; capabilities all `true`; constructor `(clientFactory @Inject(MOONSHOT_CLIENT), ConfigService, EventEmitter2, MoonshotBatchStore, MoonshotExtractStore)` |
| `moonshot.usage.ts` | `tokensFromUsage(usage) → UsageTokens`; ~~`serviceTierFromUsage` analogue~~ **not implemented** — no such function exists in `moonshot.usage.ts`. `serviceTier` is instead derived structurally at the two emission sites: the sync path (`moonshot.service.ts`) hardcodes `'standard'`, and the batch reconciler hardcodes `'batch'` for every batch-sourced usage event (native or emulated) — see §6.5. |
| `moonshot.constants.ts` | `MOONSHOT_CLIENT` token; `BATCHABLE_MODELS` set; `isBatchable(model)` |
| `moonshot.module.ts` | `@Global`; lazy memoized `openai` client (baseURL, key from config, throws `UnauthorizedException` when key unset so app boots keyless); provides `MoonshotLlmProvider`, stores |
| `moonshot.envelope.ts` | `buildRequest(envelope, prompt)` → OpenAI `messages[]` (stable tiers → leading `system` messages, file blocks resolved to extracted text, trailing prompt as final `user`) + derived `prompt_cache_key` |
| `moonshot.batch-store.ts` | Firestore-backed durable store for emulated batches (`moonshotBatches/{batchId}` + `.../items/{customId}`) |
| `moonshot.extract-store.ts` | Firestore-backed content-hash → extracted-text store (`moonshotExtracts/{hash}`) + in-memory LRU |
| `moonshot.batch-worker.ts` | Drains pending emulated-batch items with bounded concurrency; retry/backoff; `OnApplicationBootstrap` recovery; GC cron for terminal batches |
| `*.spec.ts` | contract, usage, envelope, emulated-batch (incl. recovery), native-batch, pricing specs |

### Modified (neutral seams only)

| File | Change |
|---|---|
| `backend/src/llm/llm.module.ts` | `imports: [..., MoonshotModule]`; `case 'moonshot': return moonshot;` |
| `backend/src/config/configuration.ts` | add `moonshot` block; make `benchmark.model` default provider-aware (`kimi-k3` when `LLM_PROVIDER=moonshot`) |
| `backend/src/cost/pricing.ts` | add optional `batchMultiplier?`/`cacheReadMultiplier?` to `RateEntry`; use overrides in `priceUsage`; add 3 Moonshot rate entries |
| `backend/src/benchmark/benchmark.types.ts` | add `MODEL_ALIASES` entries `k3/k26/k27-code`; add `flagship` resolution |
| `backend/src/benchmark/seven-keys/seven-keys.service.ts` | replace literal `claude-fable-5` pin with the provider-aware `flagship` |
| `backend/.env.example` | document `MOONSHOT_*` vars |
| `backend/package.json` | add `openai` dependency |
| `backend/src/app.module.ts` | ensure `MoonshotModule` import ordering (before `LlmModule`) |

Anthropic's `message()`/demo path is untouched.

## 6. Detailed design

### 6.1 `messageStructured` (sync; used by seven-keys)

- Resolve `model` (`req.model ?? config moonshot.model`), `maxTokens` (`req.maxTokens ?? config`),
  effort map (`low/high/max`, default `high`). **As landed:** the config key is `moonshot.maxTokens`
  (env `MOONSHOT_MAX_TOKENS`, default `32000`) — it did not exist when this spec was written and
  call sites inlined the `32000` literal; it was added in a later commit so the default lives in
  one place instead of being repeated at every call site.
- Build messages via `moonshot.envelope.buildRequest(req.envelope, req.prompt)`; if no envelope,
  a single `user` message with `req.prompt` (and `req.system` as a leading `system` message).
- Request: `{model, messages, max_completion_tokens, reasoning_effort,
  response_format:{type:'json_schema', json_schema:{name:'setup', strict:true,
  schema: toMoonshotSchema(schema)}}, prompt_cache_key}` (omit `temperature`/`top_p`/`top_k`
  entirely; see §6.1.1 for `toMoonshotSchema` and the fallback).
- Emit `llm.usage` (`source:'sync'`, `serviceTier:'standard'`) **before** any refusal throw,
  mirroring Anthropic ordering.
- Errors: `content_filter` (400) → HTTP 422 refusal; `finish_reason==='length'` → HTTP 502
  (incomplete); non-JSON `content` → HTTP 502; map `429/5xx` to the existing rethrow shape.
- Parse `choices[0].message.content` → `JSON.parse`.

### 6.1.1 Structured-output strict mode & fallback (D8)

Moonshot `strict:true` json_schema is expected to follow OpenAI strict semantics, which — unlike
the Anthropic validator `SETUP_SCHEMA` was written for — **forbid optional properties**: every key
in `properties` must appear in `required` (with `additionalProperties:false`). `SETUP_SCHEMA`
declares `rejectedAlternative` in `properties` but **not** in `required`, so a naive `strict:true`
send would reject it on the very first K3 call. Mitigation, in order:

1. **Provider-aware schema shaping — `toMoonshotSchema(schema)`:** a pure transform that adds every
   `properties` key to `required` and makes originally-optional ones nullable
   (`{ type: ['string','null'] }` or `anyOf:[<T>,{type:'null'}]`, whichever `walle` accepts). The
   reconciler already tolerates a missing/`null` `rejectedAlternative`, so nulling it is safe. This
   keeps `strict:true` (highest reliability) while satisfying OpenAI-strict. Applied on **both** the
   sync (`messageStructured`) and batch (JSONL body / emulated item) paths so they share one shape.
2. **`walle` CI validation** of the shaped schema before shipping (the docs provide this validator
   for `strict=true`). **As landed:** this repo has no `walle` CLI (it is a Moonshot-docs-provided
   external tool, not part of this codebase's toolchain). In its place, `moonshot.chat.spec.ts` runs
   `toMoonshotSchema` over this repo's real seven-keys schemas (`SETUP_SCHEMA`, `CURRENT_SCHEMA`,
   `LOOKBACK_SCHEMA`, `SYNTH_SCHEMA`, `VERIFY_SCHEMA`) and asserts the shaped-schema invariants
   (every property required, `additionalProperties:false`, optionals nullable) unconditionally —
   functionally the same guarantee `walle` would provide, enforced as a committed test instead of an
   external CI step.
3. **Implemented fallback (not just named):** if a model/schema rejects strict json_schema, fall
   back to `response_format:{type:'json_object'}` + a trailing `{role:'assistant', content:'{',
   partial:true}` prefill to force a JSON object, then rely on the existing downstream `JSON.parse`
   + reconciler re-validation. Selected per call via a small helper so sync and batch share it.

### 6.2 Envelope / caching (`moonshot.envelope.ts`)

Moonshot caching is implicit on a byte-identical prefix, so **no `cache_control`, no breakpoints,
no 4-breakpoint budget** (all Anthropic-specific). Instead:

- Render each `PromptEnvelope` tier deterministically, **in order**, as one leading `system`
  message per tier (stable prefix). `{type:'file', fileId}` blocks are resolved to their
  extracted text via `MoonshotExtractStore` and inlined; `{type:'text', text}` pass through.
- `envelope.system` (if set) becomes the first `system` message. (The benchmark's `fullEnvelope`
  never sets `system` — everything is in tiers — but support it for `messageStructured` callers.)
- Append the variable per-request `prompt` (e.g. `TRAILING_PROMPT`) as the final `user` message,
  uncached.
- `prompt_cache_key = sha256(renderedStablePrefix)` — identical across all `runIndex` of a
  `(trader, day, variant, model)` cell, matching how the cache-warmer dedups.
- Warm and real calls must carry identical `model`/`reasoning_effort`/`response_format` so they
  land the same implicit cache. (The cache-warmer already passes the same `schema`+`effort`.)

The benchmark's stable prefix (from `envelope.builder.ts` `fullEnvelope`): Tier 1 general
docs + task framing; Tier 2 = day PDF (file block) + TP transcript + recap transcript; Tier 3
persona; Tier 4 (non-`base`) feature/scorecard; trailing `TRAILING_PROMPT`.

### 6.3 File handling (`uploadFile` + `MoonshotExtractStore`)

Doc-recommended flow, made cross-process durable:
1. `hash = sha256(bytes)`.
2. If `moonshotExtracts/{hash}` exists (or LRU hit) → return `moonshot-extract:{hash}`.
3. Else: upload `purpose:'file-extract'` → `GET /v1/files/{id}/content` (extracted text) →
   persist text under `moonshotExtracts/{hash}` → `DELETE /v1/files/{id}` (respect 1,000-file
   cap) → return `moonshot-extract:{hash}`.

The synthetic id is opaque to the benchmark (day-artifacts persists whatever string
`uploadFile` returns and reuses it across processes). `buildRequest` resolves
`moonshot-extract:{hash}` → text from the store (LRU in front).

**Firestore 1 MiB doc limit:** trade-plan PDF extracts are small, but if an extract exceeds
~900 KB it is chunked across `moonshotExtracts/{hash}/chunks/{n}` and reassembled on read.

### 6.4 Hybrid batch

`submitBatch` branches on `isBatchable(opts.model ?? default)`:

**Native path (batchable: k2.6 / k2.7-code / ~~k2.5~~):** `kimi-k2.5` was dropped from
`BATCHABLE_MODELS` as landed — it has no priced rate row and no `MODEL_ALIASES` entry, and is
closed to new users with a full sunset of 2026-08-31, so real native-batch spend on it would record
as unpriced $0. An unlisted model falls back to emulated batch, so this loses no capability; it only
narrows the native path to the two models this repo actually prices.

- Build JSONL: one line `{custom_id, method:"POST", url:"/v1/chat/completions", body}` per item,
  where `body = {model, messages(from per-item envelope ?? batch envelope), max_completion_tokens,
  reasoning_effort, response_format}`. **Strip `temperature`/`top_p`.** Enforce single `model`.
- Upload JSONL `purpose:"batch"` → `POST /v1/batches {input_file_id, endpoint:"/v1/chat/completions",
  completion_window: config (default "1d")}`.
- `getBatch`: `GET /v1/batches/{id}` → status map: `completed→ended`, `failed→errored`,
  `expired→expired`, `cancelling|cancelled→canceled`, `validating|in_progress|finalizing→in_progress`.
  Pass `request_counts` through as `requestCounts`.
- `getBatchResults`: read `output_file_id` (+ `error_file_id`) via files content, parse JSONL,
  map per `custom_id`: `status_code 200` + parseable content → `succeeded` (text + usage via
  `tokensFromUsage`, `cacheReadTokens = cached_tokens`); content_filter → `refusal`; else `errored`.

**Emulated path (K3):** durable worker + recovery (D4), hardened for multi-process safety (D5),
stuck-batch expiry (D6), and prefix-grouped cache priming (D7).

- `submitBatch`: mint `batchId = msb_{randomUUID()}` (opaque; nothing parses it) and persist a
  batch doc `moonshotBatches/{batchId}` `{batchId, model, opts(schema,maxTokens,effort),
  batchEnvelope?, status:'in_progress', total, createdAt, expiresAt}` where
  `expiresAt = createdAt + moonshot.batchMaxAgeMs` (default 3h), plus one item doc
  `.../items/{customId}` `{customId, prompt, envelope?, status:'pending', attempts:0}` per request.
  Items store the **neutral** `BatchItemRequest` (file blocks stay as ids, not resolved text), so
  docs stay small. Return `{batchId, status:'submitted'}` immediately (no LLM work inline); kick
  the worker.
- **Item claiming (D5 — multi-process safe):** the worker never runs a bare `pending` item. It
  claims each item in a **Firestore transaction**: read → if `status==='pending'`, or
  `status==='running'` with an expired `leaseUntil`, set `status:'running'`,
  `leaseUntil = now + LEASE_MS` (**30 min as landed, not 10** — worst case an item burns 4 attempts
  × 2 API calls each, at high/max effort with a 32k-token ceiling, before terminating; a lease that
  lapses mid-flight lets another drainer double-run and double-pay for the same item, so the lease
  must comfortably outlast that worst case. 30 min is also deliberately the same interval as the
  maintenance cron tick, bounding the detection gap for a crashed claim-holder to about one lease
  lifetime. A fencing token compared transactionally at the terminal write would close the
  double-pay risk properly; deferred), `attempts += 1`; else skip (another process owns it).
  Only the transaction winner issues the chat call. This makes `kick()` (from `submitBatch`, on
  whichever instance ran the benchmark) and `OnApplicationBootstrap` resume (on every booted
  instance) safe to run concurrently without ever double-spending on the same item — the
  in-process guard alone cannot span processes.
- **Prefix-grouped fan-out (D7 — real cache benefit):** group claimable items by their envelope
  hash (`sha256(JSON.stringify(item.envelope ?? batchEnvelope))`, 1:1 with `prompt_cache_key`). For
  each group, run ONE item first and await it (primes that prefix's implicit cache), then fan the
  group's remaining items out under bounded concurrency (`MOONSHOT_BATCH_CONCURRENCY`, default 8),
  with the same bound applied across groups. A single global prime warms only one of many distinct
  cell prefixes in a benchmark batch — each cell's prefix must be primed once for its sibling
  `runIndex`es to land cache hits. This is what makes the ~90% caching benefit in §6.6 actually hold
  for the emulated path.
- Each claimed item → sync `chat/completions`; on completion persist the terminal item state
  `{status:'succeeded'|'refusal'|'errored', text?, usage?, cacheReadTokens?, error?}` (which clears
  the lease). Classify: `content_filter` → `refusal` (permanent, recorded); `429`/`5xx`/network →
  retry with exponential backoff, then `errored` (transient → reconciler re-queues the run-index).
- **Batch expiry (D6 — no stuck batches):** on each drain tick, if `now > expiresAt` and any item
  is still non-terminal, mark the batch terminal `errored`. `getBatch` then returns `errored`, the
  reconciler marks its `benchmarkBatch` terminal, and the affected `runIndex`es re-queue cleanly on
  the next `run()`. Without this, a worker that dies with no instance resuming would leave the batch
  `in_progress` forever — polled every minute forever and silently re-queued into duplicate batches.
- Recovery: `OnApplicationBootstrap` (guarded to `llm.provider==='moonshot'`) scans `moonshotBatches`
  where `status:'in_progress'` and re-drains them; claiming (D5) makes this idempotent and safe
  alongside a live `kick()`.
- `getBatch`: batch doc `status` → `in_progress` | `ended` | `errored` (a batch `ends` once every
  item is terminal). `getBatchResults`: read the item docs → `BatchItemResult[]` (skip any still
  `pending`/`running`).
- GC: a cron deletes terminal (`ended`/`errored`) `moonshotBatches` older than
  `endedAt + moonshot.batchGcTtlMs` (default 24h) — keyed off the **terminal** time, not
  `createdAt`, so a lagging reconciler can never have results deleted out from under it. This also
  self-cleans the cache-warmer's fire-and-forget 1-item emulated batches (never reconciled).

The reconciler is unchanged: it treats only `succeeded`/`refusal` items as real results and
re-queues everything else; it hardcodes `serviceTier:'batch'` on emitted usage
(`batch-reconciler.ts:126`) — which pricing handles correctly (§6.6).

### 6.4.1 Cache-warmer mapping

`cache-warmer.ts` calls `this.llm.submitBatch([{prompt:'Cache warm…'}], envelope, {model, effort,
schema})` fire-and-forget. For Moonshot this becomes a 1-item emulated batch → one prime-the-prefix
sync call → warms the single implicit cache. No tier-scoped cache pools exist on Moonshot (K3 is
sync-only), so the Anthropic concern about standard-vs-batch cache visibility does not apply.

### 6.5 Usage mapping (`moonshot.usage.ts`)

From Moonshot `usage = {prompt_tokens, completion_tokens, total_tokens, cached_tokens}`:
```
input        = prompt_tokens - cached_tokens   // uncached (cache-miss) input, full rate
cacheRead    = cached_tokens                   // cache-hit input
cacheCreate5m = 0
cacheCreate1h = 0                              // Moonshot has no cache-write token concept
output       = completion_tokens
```
`serviceTier`: sync → `standard`; batch (native or emulated) → `batch` (reconciler-hardcoded).

### 6.6 Pricing (`cost/pricing.ts`)

Extend `RateEntry` with optional overrides; keep all existing globals as defaults so Anthropic
pricing is unchanged:
```ts
interface RateEntry {
  id; inputPerMTok; outputPerMTok; effectiveFrom; effectiveTo?; version;
  batchMultiplier?: number;      // overrides global TIER_MULTIPLIER.batch (0.5) when tier==='batch'
  cacheReadMultiplier?: number;  // overrides global CACHE_READ (0.1) for this model
}
```
`priceUsage`:
```
mult = tier === 'batch' ? (entry.batchMultiplier ?? TIER_MULTIPLIER.batch) : TIER_MULTIPLIER[tier];
cacheReadRate = inRate * (entry.cacheReadMultiplier ?? CACHE_READ);
```
New rate entries (`effectiveFrom:'2000-01-01'`):
```
{ id:'kimi-k3',        inputPerMTok:3.00, outputPerMTok:15.00, batchMultiplier:1.0,  version:'kimi-k3-2026-07' }
{ id:'kimi-k2.6',      inputPerMTok:0.95, outputPerMTok:4.00,  batchMultiplier:0.6, cacheReadMultiplier:0.168, version:'kimi-k2.6-2026-07' }
{ id:'kimi-k2.7-code', inputPerMTok:0.95, outputPerMTok:4.00,  batchMultiplier:0.6, cacheReadMultiplier:0.20,  version:'kimi-k2.7-code-2026-07' }
```
Rationale: K3 emulated batch emits `serviceTier:'batch'` but is not discounted → `batchMultiplier:1.0`
prices it at standard. K3 cache-read ($0.30 = 0.1×$3.00) equals the global `CACHE_READ`, so no
override. Code-model batch = 60% of standard (40% off) with their own cache-read ratios
(hit/miss: 0.16/0.95, 0.19/0.95). Moonshot never emits cache-create tokens, so `CACHE_WRITE_*`
premiums stay moot.

### 6.7 Model identity (`flagship`)

- `configuration.ts`: `benchmark.model` default is provider-aware —
  `LLM_PROVIDER==='moonshot' ? 'kimi-k3' : 'claude-fable-5'` (respecting an explicit
  `BENCHMARK_MODEL` override). Add `moonshot: {apiKey, baseUrl, model, batchConcurrency,
  completionWindow}`.
- `benchmark.types.ts`: `MODEL_ALIASES` gains `k3→kimi-k3, k26→kimi-k2.6, 'k27-code'→kimi-k2.7-code`.
  **Superseded — the `flagship` pseudo-alias below was NOT implemented:**
  ~~add a `flagship` alias resolved to the active provider's default model (via config), so
  `resolveModel('flagship')` yields `claude-fable-5` or `kimi-k3`.~~ `resolveModel` resolves an
  alias or a raw model id; a literal string `'flagship'` isn't either, so `resolveModel('flagship')`
  would just pass the literal `'flagship'` straight through as an unrecognized id — it can't
  special-case a magic string without the caller telling it to. As landed, the provider-aware
  flagship instead lives in `seven-keys.service.ts` as a pair of getters
  (`flagshipModel`/`flagshipAlias`) that read `config.get('benchmark.model')` and pass it through
  `resolveModel(...)` to derive the id and alias together — see the addendum to the implementation
  plan, Task 3.
- `seven-keys.service.ts`: replace the hard-pinned `claude-fable-5` literal with the config-derived
  `flagshipModel`/`flagshipAlias` getters described above (not a `flagship` alias resolution).

Net operator experience: set `LLM_PROVIDER=moonshot` (+ `MOONSHOT_API_KEY`) and the whole
benchmark + seven-keys run on `kimi-k3`.

## 7. Config / env additions

| Config key | Env var | Default |
|---|---|---|
| `moonshot.apiKey` | `MOONSHOT_API_KEY` | (unset; app boots keyless) |
| `moonshot.baseUrl` | `MOONSHOT_BASE_URL` | `https://api.moonshot.ai/v1` |
| `moonshot.model` | `MOONSHOT_MODEL` | `kimi-k3` |
| `moonshot.batchConcurrency` | `MOONSHOT_BATCH_CONCURRENCY` | `8` |
| `moonshot.completionWindow` | `MOONSHOT_COMPLETION_WINDOW` | `1d` |
| `moonshot.batchMaxAgeMs` | `MOONSHOT_BATCH_MAX_AGE_MS` | `10800000` (3h) — emulated-batch expiry (D6) |
| `moonshot.batchGcTtlMs` | `MOONSHOT_BATCH_GC_TTL_MS` | `86400000` (24h) — terminal-batch GC, from `endedAt` |
| `benchmark.model` (provider-aware) | `BENCHMARK_MODEL` | `kimi-k3` when `LLM_PROVIDER=moonshot`, else `claude-fable-5` |

(`LEASE_MS`, the item-claim lease, is a fixed constant — **30 min as landed, not 10** (see §6.4's
worst-case-item rationale) — not env-tunable.)

## 8. Data model (Firestore, Moonshot-owned)

- `moonshotExtracts/{sha256}` → `{ text, filename?, mediaType?, ~~createdAt~~ }` (+ optional
  `chunks/{n}` subcollection for >~900 KB extracts). **`createdAt` was not implemented** — the
  landed `ExtractDoc` shape has no timestamp field, because no GC exists for this collection (unlike
  `moonshotBatches`, extracts are never swept). If a GC is added later, it must delete the
  `chunks/*` subcollection docs before (or atomically with) the parent doc — Firestore does not
  cascade-delete subcollections, so deleting only the parent would orphan any chunk docs under it.
- `moonshotBatches/{batchId}` → `{ batchId, model, opts, batchEnvelope?,
  status:'in_progress'|'ended'|'errored', total, createdAt, expiresAt, endedAt? }`.
- `moonshotBatches/{batchId}/items/{customId}` → `{ customId, prompt, envelope?,
  status:'pending'|'running'|'succeeded'|'refusal'|'errored', attempts, leaseUntil?, text?,
  usage?, cacheReadTokens?, error? }`.

`status:'running'` + `leaseUntil` are the claim (D5): a claim is a Firestore transaction that flips
`pending → running` (or reclaims a `running` item whose `leaseUntil` has passed) and bumps
`attempts`; only the winner runs the call. `expiresAt` bounds a stuck batch (D6).

The adapter depends on the existing global `FIRESTORE` provider (as `BenchmarkRepository` does),
wrapped behind `MoonshotBatchStore`/`MoonshotExtractStore` interfaces so the service is not
coupled to Firestore directly.

## 9. Testing

- `moonshot.contract.spec.ts` — compile-time `const port: LlmProvider = svc` assignment +
  runtime `typeof` checks + `capabilities` deep-equals `{batch,fileUpload,promptCaching,
  structuredOutput}` all `true` (mirrors `llm.contract.spec.ts`).
- `moonshot.usage.spec.ts` — `{prompt_tokens, cached_tokens, completion_tokens}` → `UsageTokens`
  (incl. `input = prompt−cached`, cache-create always 0).
- `moonshot.envelope.spec.ts` — tiers → ordered `system` messages, file-block resolution to
  extracted text, trailing prompt as final `user`, stable `prompt_cache_key` across runs.
- Emulated-batch spec — submit persists items; worker drains and terminates; **restart recovery**
  resumes `in_progress`; `content_filter`→`refusal` (kept) vs `429/5xx`→`errored` (re-queued); GC
  removes terminal batches (by `endedAt + TTL`).
- Claiming spec (D5) — two concurrent `drainBatch` calls (two simulated processes) execute each
  item **exactly once** (chat-call counter == item count); a `running` item with an expired
  `leaseUntil` is reclaimable, a fresh one is not.
- Expiry spec (D6) — a batch past `expiresAt` with non-terminal items is marked `errored` and stops
  being polled; `getBatch` returns `errored`.
- Grouped-priming spec (D7) — items sharing an envelope are primed once (first group call awaited
  before the group's rest start); distinct envelopes each get their own prime.
- Schema-shaping spec (D8) — `toMoonshotSchema(SETUP_SCHEMA)` marks every property `required` with
  the optional one nullable; a strict-reject engages the `json_object`/`partial` fallback.
- Native-batch spec — JSONL line shape (no `temperature`/`top_p`; single model; `endpoint`;
  `completion_window` mapping/validation), status mapping, output/error-file parsing.
- Pricing spec — K3 batch priced == standard (`batchMultiplier:1.0`); code models 40% off;
  cache-read ratios; **Anthropic pricing regression unchanged**.
- Fake/double — extend `FakeLlmProvider` only if needed for new neutral behaviors (the port is
  unchanged, so existing benchmark specs keep passing untouched).

## 10. Risks & open items

- **Structured-output strict mode:** addressed in §6.1.1 (D8) via `toMoonshotSchema` shaping +
  `walle` validation + a `json_object`/`partial` fallback — no longer an open risk, since
  `SETUP_SCHEMA`'s optional `rejectedAlternative` would otherwise fail `strict:true` on the first
  K3 call.
- **K3 completion-token budget:** K3 always reasons at `reasoning_effort` high/max, and the 32000
  `max_completion_tokens` default (tuned for Fable) may truncate a heavy-reasoning setup
  (`finish_reason:length` → 502 → retry churn). Track the truncation rate; raise
  `BENCHMARK_MAX_TOKENS` for K3 if observed (K3 ceiling is 1,048,576).
- **Multi-process emulated drain:** addressed by transactional item claiming (§6.4, D5); the
  in-process guard alone is insufficient when `kick()` and bootstrap-resume run on different
  instances.
- **Firestore write amplification:** emulated batches write one item doc at submit + one claim
  transaction + one result write per request — thousands of writes on a large run vs Anthropic's
  single server-side batch. Well within Firestore's per-DB write ceiling, but the cost/throughput
  trade-off is the price of durable emulation; batchable models (native path) avoid it.
- **Firestore 1 MiB limit** on extracted text — mitigated by chunking (§6.3).
- **Rate limits / tiers:** Moonshot concurrency/RPM are tiered by cumulative recharge; the
  emulated worker must honor `MOONSHOT_BATCH_CONCURRENCY` and back off on
  `rate_limit_reached_error` (429). 429s are not charged.
- **Cache TTL is system-managed / unpublished** — the 55-min cache-warmer cadence is a
  reasonable heuristic; monitor `cached_tokens/prompt_tokens` as the real hit rate.
- **`openai` SDK TS types** lack Moonshot fields → thin wrapper types + `as any` at call sites.
- **Native batch input files are never swept:** the provider deletes an input file whose
  `batches.create` failed, and deletes it again once `getBatchResults` reads a *terminal* batch —
  but a batch nobody ever reconciles (the cache warmer's fire-and-forget submissions, a run whose
  process died mid-flight) keeps its `purpose:'batch'` input file forever, against Moonshot's
  1,000-file / 10GB account cap. Output/error files are left to Moonshot's own retention and are
  not swept either. Trigger to fix: sustained native-batch warming of `k2.6`/`k2.7-code`, or a
  `files.create` 400 "too many files" — then add a stale-batch-file sweep to
  `MoonshotBatchWorker.maintain()` alongside the emulated GC. Bounded today because the native path
  only engages when an operator explicitly benchmarks a batchable model (§11).
- **A GC'd emulated batch the reconciler never terminalized:** the worker deletes terminal
  `moonshotBatches` 24h after `endedAt` (§6.4), after which `getBatch` 404s for that `msb_` id — so
  a `benchmarkBatch` doc still marked `in_progress` is polled, and logs an error, once a minute
  indefinitely. It takes the reconciler being down or stalled for ~24h while the worker's GC keeps
  running, which normally cannot happen (same process, so both stop together). Symptom: one
  recurring per-minute error for a single `msb_` id; the fix is to terminalize a `benchmarkBatch`
  whose provider batch has vanished.

## 11. Out of scope (YAGNI)

- No multi-turn/tool-calling loops (benchmark is single-shot structured calls); no need to echo
  back `reasoning_content`.
- No vision/video input paths.
- No third-party Moonshot hosts (OpenRouter/Together) — official API only.
- No change to Anthropic adapter behavior, the neutral port, or benchmark/reconciler/cost logic
  beyond the documented seams.
- Native batch is built for completeness (D3) but is exercised only when an operator explicitly
  benchmarks a batchable model; the default flagship K3 always uses emulation.
