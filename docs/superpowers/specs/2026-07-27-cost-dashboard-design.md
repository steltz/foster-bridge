# Anthropic API Cost Dashboard — Design

**Date:** 2026-07-27
**Status:** Approved (design); pending implementation plan
**Scope:** `backend/` (NestJS)

## Goal

Make the cost of **every** Anthropic API request — standard and batched — a
first-class, queryable citizen. Capture one immutable cost record per request,
attributed by service tier, operation/purpose, benchmark coordinates, and time;
expose aggregation endpoints; and generate a self-contained HTML report the user
opens locally.

## Motivation / current state

Cost tracking is greenfield. Every Anthropic response already carries `usage`
(input / output / cache tokens), but the app **discards it everywhere** except
the cache-verification path. `service_tier` is never read. Nothing stores token
counts or dollar cost. (`BenchmarkCell.dollars` is trade P&L from the backtester,
unrelated to API cost.)

## Decisions locked

- **Cost source:** compute locally from `usage` × a versioned rate table. (Not
  the org-level Cost API, which can't attribute to operation/cell.)
- **Coverage:** all Anthropic calls — warms, `message`, `messageStructured`,
  batch setups, seven-keys generation, demo endpoints.
- **Breakdowns:** service tier, operation/purpose, benchmark coordinates, over time.
- **Grain:** one record per request (each batch item costed individually).
- **Capture wiring:** choke-point in `AnthropicService` + `BatchReconciler`,
  decoupled via **Nest EventEmitter** (`@nestjs/event-emitter`). Fallback if the
  dep is unwanted: an injected `UsageRecorder` token.
- **Attribution is required** on every emitting method (`message`,
  `messageStructured`, `warmCache`) — a missing attribution is a **compile
  error**, never a silent `message` bucket. Every internal caller (benchmark
  warms, the periodic cache-warmer, seven-keys generation, demo endpoints) passes
  its own `operation`.
- **Report surface:** `GET /costs/report` returns a self-contained HTML document
  (data embedded); `curl localhost:3000/costs/report -o costs.html` and open it.
  Regenerate to refresh. (A `node dist/cost-report.js` CLI was the alternative;
  the endpoint was chosen.)

## Pricing reference (initial rate table, per MTok)

| Model (alias) | Input | Output |
| --- | --- | --- |
| `claude-fable-5` (fable) | $10 | $50 |
| `claude-opus-4-8` (opus) | $5 | $25 |
| `claude-sonnet-5` (sonnet) | $3 ($2 intro through 2026-08-31) | $15 ($10 intro) |
| `claude-haiku-4-5` (haiku) | $1 | $5 |

Cache multipliers on the model's **input** rate: 5m write ×1.25, 1h write ×2.0,
read ×0.1. **Batch tier = ×0.5** on the whole computed cost. Benchmark warms and
batch use **1h** TTL (the ×2.0 write tier). Rates are sourced from the
`claude-api` skill's cached table; re-verify against live pricing if a rate looks
stale.

## Architecture — `CostModule`

```
backend/src/cost/
  cost.types.ts        UsageEvent, Attribution, Operation, ServiceTier, CostRecord
  pricing.ts           versioned rate table + priceUsage() — pure, test-heavy core
  cost.service.ts      onUsage(event) → price → persist; summarize(query)
  cost.repository.ts   Firestore `costRecords` collection
  cost.controller.ts   GET /costs/summary, /costs/records, /costs/report
  report.builder.ts    self-contained HTML (data embedded)
  cost.module.ts
```

`AnthropicService` and `BatchReconciler` `emit('anthropic.usage', UsageEvent)`;
`CostModule`'s `@OnEvent('anthropic.usage')` listener consumes them. This keeps
`AnthropicModule` independent of `CostModule` (no circular dependency).
Persistence is **fire-and-forget** — the emitter does not await the Firestore
write, so cost capture never adds latency to, or fails, the real request.
`EventEmitterModule.forRoot()` is registered in `AppModule`.

## Data model — `costRecords` (Firestore)

```jsonc
{
  "id": "<batchId>:<customId>  (batch)  |  uuid (sync)",
  "timestamp": "ISO-8601 UTC",
  "model": { "alias": "fable", "id": "claude-fable-5" },
  "serviceTier": "standard | batch | priority",
  "operation": "warm | setup | keys-generation | demo | message | other",
  "benchmark": {                       // optional; present for bench-attributed calls
    "modelAlias": "fable", "day": "07222026",
    "trader": "context-trader", "variant": "base", "runIndex": 1
  },
  "tokens": {
    "input": 20, "cacheRead": 3227,
    "cacheCreate5m": 0, "cacheCreate1h": 16434, "output": 2157
  },
  "cost": {                            // USD; null when the model is unpriced
    "input": 0, "cacheRead": 0, "cacheCreate": 0, "output": 0, "total": 0
  },
  "pricingVersion": "2026-07",
  "source": "sync | batch",
  "batchId": "msgbatch_..."            // batch only
}
```

- **Idempotency:** batch records are keyed `${batchId}:${customId}` and written
  once — a re-reconcile does not double-count. Sync records use a UUID (a retried
  sync call is a genuinely new cost).
- Records are **append-only**; no updates.

## Cost calculation (`pricing.ts`)

```
base = input        · R_in
     + cacheRead     · R_in · 0.1
     + cacheCreate5m · R_in · 1.25
     + cacheCreate1h · R_in · 2.0
     + output        · R_out
total = base × (tier === 'batch' ? 0.5 : tier === 'priority' ? P_priority : 1)
```

- **Versioned + date-windowed table:** each entry carries `effectiveFrom` /
  optional `effectiveTo`. `priceUsage` selects the entry whose window contains the
  record's `timestamp` — so Sonnet's $2/$10 intro then $3/$15 both price
  correctly. The selected version label is stored on the record
  (`pricingVersion`), making historical cost reproducible after a table change.
- **Cache-creation TTL split:** read from
  `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` when the SDK
  provides it. If only the flat `cache_creation_input_tokens` is present, attribute
  it to **1h**, because every cached path in this app uses 1h TTL
  (`ONE_HOUR_CACHE_CONTROL`). Any future 5m path must surface its TTL to the
  capture layer explicitly rather than relying on this fallback.
- **Unknown model id:** record saved with `cost: null` and a `note`; surfaced as
  "unpriced" in the report. `priceUsage` never throws into the request path.
- **Net cache economics:** `priceUsage` also returns `uncachedInputEquiv` — the
  counterfactual cost of pricing *all* input-side tokens
  (`input + cacheRead + cacheCreate5m + cacheCreate1h`) as plain uncached input at
  the model's input rate × tier. This lets the dashboard report the **net** cache
  benefit — `uncachedInputEquiv − (input + cacheRead + cacheCreate)` paid — which
  can go **negative** when 1h write premiums (×2.0) outweigh the read discount on
  a low-reuse prefix. The old "cache savings" number (gross read discount only)
  ignored write cost and could not show a net loss; net is the honest metric, and
  the gross read discount is kept alongside it for context.
- `priceUsage` is a **pure function** — the primary unit-test surface.

## Capture points & attribution

- **Sync** (`message`, `messageStructured`, `warmCache`): add an optional
  `attribution` argument to each. After the response, emit a `UsageEvent`
  carrying `usage`, `serviceTier = usage.service_tier ?? 'standard'`, model, and
  attribution. Covers the warm calls — now a real Standard-tier cost after the
  `max_tokens: 16` structured-warm fix.
- **Batch:** `createBatch` returns no usage (async). Per-item cost is emitted from
  `BatchReconciler` while it streams `getBatchResults`, with attribution built
  from `parseCellKey(customId)` + the `BatchDoc` (model, day) and tier `'batch'`.
  `succeeded` and `refusal` items carry usage → costed; transient `errored` items
  have none → no record (matches the reconciler already skipping them).
- Attribution supplied by callers:
  - `benchmark.service` warms → `{ operation: 'warm', benchmark: {day, trader, variant} }`
  - **`cache-warmer.service` periodic re-warms → `{ operation: 'warm', benchmark: {day, trader, variant} }`** (previously missed — would have mislabeled as `message`)
  - batch setups → `{ operation: 'setup', benchmark: {…from customId} }` (at reconcile)
  - `seven-keys.service` → `{ operation: 'keys-generation', benchmark: {day} }`
  - demo endpoints → `{ operation: 'demo' }`
  - Attribution is **required** — there is no silent default; a caller that emits
    without it fails to compile.

## Aggregation API

- `GET /costs/summary?groupBy=tier|operation|model|day|trader|variant|date&from&to&model`
  → totals + per-group `{records, tokens, usd}`, plus **`netCacheBenefitUsd`** and
  **`grossCacheReadDiscountUsd`**. `date` groups by the request's **calendar day**
  (`timestamp` UTC date) — the "over time" dimension — distinct from `day`, which
  is the benchmark **trading** day (MMDDYYYY).
- `GET /costs/records?...filters` (paginated) — raw records for drill-down.
- `GET /costs/report` — the self-contained HTML report.

## HTML report

`GET /costs/report` returns a **self-contained** page: inline CSS/JS, all data
embedded as JSON (a snapshot at generation time), theme-aware (light/dark).
Contents:

- KPI tiles: total spend, total requests, total tokens, **standard vs batch
  split**, **net cache benefit** (can be negative), and gross cache read discount.
- A **spend-over-time** chart bucketed by the request calendar date (always
  rendered), plus a breakdown table whose grouping dimension (including `date`)
  is user-selectable, with benchmark drill-down.

The `dataviz` skill is loaded at build time for the chart/palette work.

## Error handling & guarantees

- Cost capture is **best-effort**: any pricing or persistence error is logged and
  the record dropped — the originating API call always succeeds.
- Records are append-only; batch records are write-once (idempotent re-reconcile).
- `priceUsage` never throws; unknown models yield `cost: null`, not an exception.
- Priority tier: multiplier stubbed (unused by the app today), handled gracefully.

## Testing

- `pricing.spec.ts` — table-driven: every model, every token type, batch ×0.5,
  cache TTL tiers (5m / 1h / read), unknown-model → null, Sonnet intro-vs-standard
  date-window selection. Highest-value surface.
- `cost.service.spec.ts` — `onUsage` prices and persists via a fake repository;
  batch idempotency (same `${batchId}:${customId}` written once).
- `report.builder.spec.ts` — given records, emits HTML with correct embedded
  totals and cache-savings math.
- e2e (in-memory Firestore fake, matching existing e2e style) — emit usage →
  `GET /costs/summary` returns the expected aggregation.
- Wiring: assert `AnthropicService` sync methods and `BatchReconciler` emit a
  `UsageEvent` per request.

## Out of scope (v1)

- **Backfill** of already-run batches/warms (capture-forward only). Batch results
  live ~29 days at Anthropic, so a backfill script can be added later; warm/probe
  usage from before this feature is not recoverable.
- Live org-level Cost-API reconciliation (local table chosen).
- Real Priority-tier usage (multiplier stubbed).
- Auth on `/costs` endpoints (same posture as the rest of the app).
