# Moonshot (Kimi) API — General Specifications

*Focused on Kimi K3. Current as of July 28, 2026 — K3 launched July 16, so treat this as a snapshot of a fast-moving platform, not a permanent reference. Scoped to the official API at `api.moonshot.ai`.*

## 1. Access & Authentication

- **Base URL:** `https://api.moonshot.ai/v1`
- **Auth:** `Authorization: Bearer $MOONSHOT_API_KEY` header. Create keys at `platform.kimi.ai/console/api-keys`.
- **SDK compatibility:** Fully OpenAI-compatible — use the standard `openai` SDK (Python ≥1.0, Node ≥18) and just repoint `base_url`/`baseURL`.
- **Minimum top-up:** $1 cumulative recharge required before any key works; flagship models (K3) also require this to unlock.
- **Key isolation:** keys issued on `platform.kimi.ai` are not valid against other regional Kimi platforms (e.g. `api.moonshot.cn`) — mismatched keys return 401.
- Requests generally run with a ~2-hour timeout.

## 2. Model Lineup

| Model ID | Context | Notes |
|---|---|---|
| `kimi-k3` | 1,048,576 tokens | Flagship. 2.8T params, native vision, always-on reasoning (`reasoning_effort`). |
| `kimi-k2.7-code` | 262,144 tokens | Coding-focused, thinking always on. |
| `kimi-k2.7-code-highspeed` | 262,144 tokens | Same model, ~180 tok/s (up to 260 tok/s short-context) output. |
| `kimi-k2.6` | 262,144 tokens | General-purpose, vision + text/video input, thinking **and** non-thinking modes. |
| `kimi-k2.5` | 262,144 tokens | Closed to new users post-K3 launch; full sunset Aug 31, 2026. |
| `moonshot-v1-8k/32k/128k(-vision-preview)` | 8k–128k | Legacy generation models; same closure/sunset as above. |

**Fully discontinued** (no longer callable): `kimi-k2-0905-preview`, `kimi-k2-0711-preview`, `kimi-k2-turbo-preview`, `kimi-k2-thinking`, `kimi-k2-thinking-turbo` (May 25, 2026), `kimi-latest` (Jan 28, 2026), `kimi-thinking-preview` (Nov 11, 2025).

If unsure, start with `kimi-k3`; drop to `kimi-k2.7-code-highspeed` for latency-sensitive coding loops.

## 3. Chat Completions — `POST /v1/chat/completions`

The core endpoint. Stateless — the API retains no history, so multi-turn conversations resend the full `messages` array each call, appending the previous assistant reply (and tool results) before the next user turn.

**`messages[]`** — each item has `role` (`system` | `user` | `assistant` | `tool`) and `content`. `content` is either a plain string or an array of typed parts for multimodal input:
```json
{"type": "text", "text": "..."}
{"type": "image_url", "image_url": {"url": "data:image/png;base64,..." }}
{"type": "video_url", "video_url": {"url": "ms://<file_id>"}}
```
Image/video `url` accepts base64 data URIs or an `ms://<file_id>` reference to an uploaded file — **not** public image URLs. Recommended ceilings: images ≤4K resolution, video ≤1080p; for large or reused media, upload via the Files API instead of inlining base64 every call.

**K3-specific request fields:**
| Field | Values | Notes |
|---|---|---|
| `reasoning_effort` | `low` \| `high` \| `max` (default `max`) | K3 always reasons — there's no way to disable thinking, only dial effort. |
| `max_completion_tokens` | up to 1,048,576 | Defaults to 131,072. `max_tokens` is deprecated. |
| `temperature`, `top_p`, `n`, `presence_penalty`, `frequency_penalty` | — | **Fixed** at 1.0 / 0.95 / 1 / 0 / 0 for K3 — omit them rather than setting them. |

**Shared/general fields (all models):**
- `response_format`: `{"type": "text"}` (default) · `{"type": "json_object"}` · `{"type": "json_schema", "json_schema": {"name", "strict", "schema"}}` — schema must follow Moonshot's "MFJS" spec, validated via the `walle` CLI.
- `tools` / `tool_choice`: standard OpenAI-style function-calling. `tool_choice`: `auto` | `none` | `required` | `{"type":"function","function":{"name":...}}`.
- **Dynamic tool loading (K3):** insert `{"role": "system", "tools": [...]}` (no `content` field) anywhere in `messages` to make tools available from that point onward — useful for large tool inventories you don't want in the initial context.
- `prompt_cache_key`: string, optional — groups requests from one logical session for better cache routing. Recommended for any multi-turn/agent workload.
- `safety_identifier`: string, optional — stable (hashed) per-end-user ID for abuse detection.
- `partial`: `true` on a trailing `assistant` message to prefill/continue a response (e.g. force a JSON `{` or code-fence prefix).
- `stream` + `stream_options: {"include_usage": true}`: SSE streaming; the usage block only appears on the final chunk (or is dropped entirely if the stream is interrupted).
- `stop`: up to 5 strings, ≤32 bytes each.

**Response shape:**
```json
{
  "choices": [{
    "message": { "role": "assistant", "content": "...", "reasoning_content": "...", "tool_calls": [...] },
    "finish_reason": "stop | length | tool_calls"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "cached_tokens": 0 }
}
```
`reasoning_content` carries K3's thinking trace. **In multi-turn or tool-calling loops, append the complete assistant message object back into `messages` — not just `.content`** — K3's reasoning is preserved across turns and truncating it degrades both output quality and cache-prefix stability.

## 4. Files API

| Endpoint | Purpose |
|---|---|
| `POST /v1/files` | Upload. `purpose`: `file-extract` (text/OCR extraction) \| `image` \| `video` \| `batch` (JSONL). |
| `GET /v1/files` | List uploaded files. |
| `GET /v1/files/{id}` | File metadata. |
| `GET /v1/files/{id}/content` | Extracted text (only for `file-extract` uploads). |
| `DELETE /v1/files/{id}` | Delete. |

**Limits:** 100MB per file, 1,000 files and 10GB total per account. Upload/extraction is currently free — billing starts once extracted content is sent as chat-completion input.

**Formats:** pdf, txt, csv, doc/docx, xls/xlsx, ppt/pptx, md, html, json, epub/mobi, most image formats (OCR included), and most common source-code extensions.

**Pattern:** upload → `files.content(file_id).text` → place that extracted **text** (not the file ID) into a `system`-role message, one message per file, at the head of `messages`. Detailed caching strategy for this pattern is in the companion doc, `kimi-k3-caching-strategy.md`.

## 5. Context Caching

Automatic on every request — no cache ID, TTL, or extra parameter. The system reuses a matching, stable initial context (system prompts, documents, tool defs) across calls; the prior request's prompt must exceed 256 tokens to be eligible. See the caching doc for the full strategy — the short version: keep your prefix byte-identical and put variable content last.

## 6. Token Estimation — `POST /v1/tokenizers/estimate-token-count`

Same request shape as chat completions (`model` + `messages`); returns `{"data": {"total_tokens": N}}`.

⚠️ **Gap as of this writing:** the documented `model` enum for this endpoint lists `kimi-k2.7-code`, `-highspeed`, `kimi-k2.6`, `kimi-k2.5`, and the `moonshot-v1-*` family — **`kimi-k3` is not in it.** Likely a docs lag rather than an intentional exclusion, but verify against your account before depending on it for K3 token budgeting.

## 7. Rate Limits

Tiered by **cumulative lifetime recharge** (not a subscription), applied per account, not per key:

| Tier | Cumulative Recharge | Concurrency | RPM | TPM | TPD |
|---|---|---|---|---|---|
| 0 | $1 | 1 | 3 | 500,000 | 1,500,000 |
| 1 | $10 | 50 | 200 | 2,000,000 | Unlimited |
| 2 | $20 | 100 | 500 | 3,000,000 | Unlimited |
| 3 | $100 | 200 | 5,000 | 3,000,000 | Unlimited |
| 4 | $1,000 | 400 | 5,000 | 4,000,000 | Unlimited |
| 5 | $3,000 | 1,000 | 10,000 | 5,000,000 | Unlimited |

Vouchers (e.g. the $5 voucher granted at $5 cumulative) don't count toward tier thresholds. Whichever ceiling — concurrency, RPM, TPM, or TPD — is hit first triggers a 429.

## 8. Error Reference

Every error returns `{"error": {"type": "...", "message": "..."}}`.

| HTTP | `error.type` | Typical cause |
|---|---|---|
| 400 | `content_filter` | Input/output flagged by safety review. |
| 400 | `invalid_request_error` | Bad format/missing param, input too long, `prompt + max_tokens` over spec, bad file `purpose`, file >100MB or 0 bytes, too many files. |
| 401 | `invalid_authentication_error` / `incorrect_api_key_error` | Malformed, missing, or wrong-platform key. |
| 403 | `permission_denied_error` | Account lacks API/model access, cross-user access attempt, or IP not allowlisted. |
| 404 | `resource_not_found_error` | Unknown or inaccessible `model` value. |
| 429 | `engine_overloaded_error` | Node-level overload — retry later. |
| 429 | `exceeded_current_quota_error` | Insufficient balance / disabled account. |
| 429 | `rate_limit_reached_error` | Concurrency/RPM/TPM/TPD ceiling hit — back off or upgrade tier. |
| 499 | `client_closed_request` | Client disconnected mid-stream. |
| 500 | `server_error` / `unexpected_output` | Internal error — retry, include `request_id` if contacting support. |
| 503 | `server_unavailable` | Temporary outage/scaling — retry later. |

Note: requests that fail with 429 are not charged.

## 9. Pricing (officially confirmed, per 1M tokens)

| Model | Cache hit | Cache miss | Output | Context |
|---|---|---|---|---|
| `kimi-k3` | $0.30 | $3.00 | $15.00 | 1,048,576 |
| `kimi-k2.7-code` | $0.19 | $0.95 | $4.00 | 262,144 |
| `kimi-k2.7-code-highspeed` | $0.38 | $1.90 | $8.00 | 262,144 |
| `kimi-k2.6` | $0.16 | $0.95 | $4.00 | 262,144 |

Excludes tax. No separate "cache write" surcharge on any model — a miss just costs the standard input rate. K2.5 / Moonshot V1 pricing exists but both are closed to new users ahead of the Aug 31 sunset, so omitted here as a poor basis for new integrations.

## 10. Minimal reference call (TypeScript)

```typescript
import { OpenAI } from "openai";

const client = new OpenAI({
  apiKey: process.env.MOONSHOT_API_KEY,
  baseURL: "https://api.moonshot.ai/v1",
});

const completion = await client.chat.completions.create({
  model: "kimi-k3",
  reasoning_effort: "max",
  messages: [
    { role: "system", content: "You are a precise technical assistant." },
    { role: "user", content: "Summarize the CAP theorem in two sentences." },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "lookup_glossary_term",
        description: "Look up a technical term",
        parameters: {
          type: "object",
          properties: { term: { type: "string" } },
          required: ["term"],
        },
      },
    },
  ],
  prompt_cache_key: "session-001",
} as any); // prompt_cache_key/reasoning_effort aren't in the official SDK's TS types yet

console.log(completion.choices[0].message.content);
console.log(completion.usage); // { prompt_tokens, completion_tokens, total_tokens, cached_tokens }
```

## Sources

- [Quickstart](https://platform.kimi.ai/docs/overview)
- [Kimi K3 Quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Model List](https://platform.kimi.ai/docs/models)
- [Create Chat Completion](https://platform.kimi.ai/docs/api/chat)
- [Files](https://platform.kimi.ai/docs/api/files) / [Upload File](https://platform.kimi.ai/docs/api/files-upload)
- [Context Caching Guide](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api)
- [Estimate Tokens](https://platform.kimi.ai/docs/api/estimate)
- [Recharge and Rate Limiting](https://platform.kimi.ai/docs/pricing/limits)
- [Common Error Codes](https://platform.kimi.ai/docs/api/errors)
- [Kimi K3 Pricing](https://platform.kimi.ai/docs/pricing/chat-k3) / [K2.6 Pricing](https://platform.kimi.ai/docs/pricing/chat-k26) / [K2.7 Code Pricing](https://platform.kimi.ai/docs/pricing/chat-k27-code)
- [Docs index (llms.txt)](https://platform.kimi.ai/docs/llms.txt)
