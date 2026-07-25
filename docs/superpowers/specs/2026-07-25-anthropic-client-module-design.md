# Anthropic API Client Module — Design

**Date:** 2026-07-25
**Status:** Approved
**Location:** `backend/src/anthropic/` (+ demo controller under `backend/src/demo/`)

## Goal

Add a NestJS module to the existing `backend/` app that wraps the official
Anthropic SDK (`@anthropic-ai/sdk`) as a reusable Claude API client, with demo
endpoints for a single non-streaming message and for the Message Batches API.
The app must build, boot, and pass tests **now**, before an
`ANTHROPIC_API_KEY` is added to `.env`.

## Non-Goals

- No streaming / SSE endpoint (explicitly out of scope for this iteration).
- No tool use, MCP, agents, or file uploads.
- No live Anthropic calls in CI.
- No committed API key anywhere.

## Constraints & Key Decisions

- **Model default `claude-sonnet-5`**, overridable via `ANTHROPIC_MODEL`.
  Adaptive thinking is left at the model default (on for Sonnet 5 when
  `thinking` is omitted) — the module does not set `thinking` explicitly.
- **Lazy client construction.** `new Anthropic()` throws at construction when
  no API key is resolvable. To keep the app booting keyless (and the e2e green
  in CI), the SDK client is built on **first use** via a memoizing factory —
  never at module init. Module boot and the readiness endpoint never construct
  the client.
- **Reuse the existing global exception filter.** `AnthropicService` catches
  typed SDK errors and rethrows Nest `HttpException`s; `GoogleErrorFilter`
  already passes `HttpException`s through untouched, so it needs no change.

## Configuration

Extends `backend/src/config/configuration.ts`. All env-overridable:

| Key | Purpose | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key (read by the SDK). **Not committed.** | *(unset for now)* |
| `ANTHROPIC_MODEL` | Model id | `claude-sonnet-5` |
| `ANTHROPIC_MAX_TOKENS` | Default `max_tokens` per request | `4096` |

`.env` is already gitignored. `.env.example` documents these plus the note
that the API guidance is ~16000 `max_tokens` for real non-streaming workloads.

## `AnthropicModule` (global)

- Provides a lazy client factory under the DI token `ANTHROPIC_CLIENT`, shaped
  `{ get(): Anthropic }`. `get()` memoizes a single
  `new Anthropic({ apiKey })` on first call, reading `apiKey` from
  `ConfigService`. Constructed lazily so module init never throws when the key
  is absent.
- Registered `@Global()`; exports `AnthropicService`.

## `AnthropicService`

Injects the `ANTHROPIC_CLIENT` factory and `ConfigService`.

### `message({ prompt, system?, model?, maxTokens? })`

- Calls `client.messages.create({ model, max_tokens, system?, messages: [{ role: 'user', content: prompt }] })`.
- `model` / `maxTokens` fall back to the configured defaults.
- **Handles `stop_reason: "refusal"` explicitly** — does not blindly read
  `content[0]`. On refusal, returns `{ model, text: null, stopReason: 'refusal', usage }`.
- Otherwise returns `{ model, text, stopReason, usage }`, where `text` is the
  concatenation of the response's `text` blocks.

### `createBatch(requests)`

- `requests`: `Array<{ customId?: string; prompt: string }>`.
- Maps each to a batch request `{ custom_id, params: { model, max_tokens, messages: [{ role: 'user', content: prompt }] } }`.
  `custom_id` defaults to `request-<index>` when not supplied.
- Calls `client.messages.batches.create({ requests })`.
- Returns `{ batchId, processingStatus }`.

### `getBatch(id)`

- `client.messages.batches.retrieve(id)`.
- Returns `{ batchId, processingStatus, requestCounts }`.

### `getBatchResults(id)`

- Iterates `client.messages.batches.results(id)` (async iterable).
- Each result is shaped by `result.type`:
  - `succeeded` → `{ customId, type: 'succeeded', text }` (concatenated text blocks).
  - `errored` / `canceled` / `expired` → `{ customId, type, error }` (message string).
- Keyed by `custom_id`; results arrive in any order, so never assume position.

### Error mapping

A private helper wraps SDK calls: catches `@anthropic-ai/sdk` typed errors and
rethrows Nest `HttpException`s —
`RateLimitError→429`, `AuthenticationError→401`, `PermissionDeniedError→403`,
`NotFoundError→404`, `BadRequestError→400`, any other `APIError→502`. Non-SDK
errors propagate unchanged (the global filter turns them into a sanitized 500).

## Endpoints — `AnthropicDemoController` (`/ai`)

| Method & path | Body / params | Returns |
| --- | --- | --- |
| `GET /ai/ready` | — | `{ configured: boolean }` from whether `ANTHROPIC_API_KEY` is set. **No live call.** |
| `POST /ai/message` | `{ prompt, system?, model?, maxTokens? }` | The shaped `message()` result. |
| `POST /ai/batch` | `{ requests: [{ customId?, prompt }] }` | `{ batchId, processingStatus }`. |
| `GET /ai/batch/:id` | — | `{ batchId, processingStatus, requestCounts }`. |
| `GET /ai/batch/:id/results` | — | Shaped results array; **409** if the batch has not `ended`. |

## Testing

- **Unit:**
  - `AnthropicModule` factory: `get()` returns a client and memoizes (single
    construction across calls).
  - `AnthropicService`: `message` result-shaping, refusal handling, and error
    mapping (each SDK error class → expected HTTP status); `createBatch`,
    `getBatch`, `getBatchResults` shaping — all with the SDK mocked (no key,
    no network).
  - Controller wiring for each route.
- **e2e:** `GET /ai/ready` returns `200 { configured: false }` booting the full
  `AppModule` — proves lazy construction does not throw at boot without a key.
  Runs in CI with no Anthropic/GCP access.
- **Live smoke test (manual, documented in README):** add `ANTHROPIC_API_KEY`,
  then `curl -X POST localhost:3000/ai/message -d '{"prompt":"Say hi"}'`.

## Deliverables

- `AnthropicModule` (lazy `ANTHROPIC_CLIENT` factory), `AnthropicService`.
- `AnthropicDemoController` with the five routes above.
- `configuration.ts` additions; `.env.example` + `README.md` updates.
- Unit + e2e tests as specified.
- `@anthropic-ai/sdk` added as a backend dependency.
