# Kimi K3 API: Prompt & Document Caching Strategy

*Research current as of July 28, 2026. Kimi K3 is very new — the API went live July 16, 2026, with full open-weight release following July 27 — so treat details as still settling. This is scoped to Moonshot's official API (api.moonshot.ai); third-party hosts (OpenRouter, Together AI, etc.) may handle caching differently.*

## Model overview

- 2.8 trillion parameters, built on Kimi Delta Attention (a hybrid linear attention mechanism) and Attention Residuals, with native visual understanding
- 1,048,576-token (1M) context window
- Mixture-of-Experts via a Stable LatentMoE framework: 16 of 896 experts active per token
- OpenAI-compatible Chat Completions API — point the standard `openai` SDK's `baseURL` at `https://api.moonshot.ai/v1`, model ID `kimi-k3`
- Always reasons — no way to disable thinking, only `reasoning_effort: low | high | max` (default `max`)
- `max_completion_tokens` defaults to 131,072, ceiling of 1,048,576
- Flagship access requires a minimum $1 account top-up

## How caching actually works

There's no cache API to call and no cache object to manage. Context Caching is automatic for every request: when the system detects a repeated initial context (system prompts, knowledge documents, tool definitions), it reuses the cached content automatically.

- **No cache ID, no TTL param.** Call `/v1/chat/completions` normally; the system matches caches in the background and manages the cache lifecycle itself.
- **There's a size floor.** A request can only land a cache hit if the *previous* request's prompt exceeded 256 tokens. Real documents clear this trivially — worth knowing only if testing with toy prompts.
- **Stability is everything.** Keep the long prefix byte-identical across calls. Any edit — reordering, rewording, even whitespace — breaks the match for everything downstream of the change.
- **Optional routing hint: `prompt_cache_key`.** A string field on the request that groups requests from the same logical session so the cache router can find them more reliably. Typically a stable session or task ID. Optional for direct API use, required on the Kimi Code Plan.
- **Pricing:**

  | | Price per 1M tokens |
  |---|---|
  | Input — cache hit | $0.30 |
  | Input — cache miss | $3.00 |
  | Output | $15.00 |

  A cache hit is 90% cheaper than a miss, with no separate "cache write" surcharge — a miss is just billed at the normal input rate. Moonshot reports the official API sustains a >90% cache hit rate on coding workloads via their Mooncake disaggregated-inference architecture.

## Strategy for prompt text

Structure every `messages` array as **[stable content first] → [variable content last]**, and never let anything after the stable boundary leak backward into it:

1. Put system instructions, persona, tool definitions, and shared reference material at the front, worded identically every call.
2. Put the user's actual question / turn-specific content at the end.
3. Pass a consistent `prompt_cache_key` per logical session or task.
4. In multi-turn or tool-calling loops, append the *complete* assistant message object back into `messages`, not just its `content` — K3 carries preserved reasoning across turns, and truncating that both hurts output quality and changes the token stream, working against a stable prefix.

## Strategy for documents

There's no separate "document cache" — once a document's content is extracted into text and sitting in `messages`, it's just more prefix, caught by the same automatic mechanism above. The real work is (a) getting document text into the prefix cheaply and (b) keeping that text identical call to call.

**Documented flow:** upload the file via `/v1/files` with `purpose="file-extract"`, retrieve the extracted text via `files.content(file_id).text`, and place that extracted *text* — not the file ID — into a `system`-role message. For multiple documents, give each file its own system message, placed at the head of the array.

**Limits:** 100MB per file, 1,000 files and 10GB total per account. Covers pdf, txt, csv, doc/docx, xls/xlsx, ppt/pptx, md, most image formats (with OCR), html, json, and most common code file extensions. Upload and extraction are currently free — billing only starts once the extracted content is sent as input to a chat completion.

**The optimization worth adding yourself:** cache the extracted text locally, keyed by a content hash, so you never re-upload or re-extract the same document. This is a different, complementary layer from Moonshot's automatic prompt cache — yours saves the extraction round trip, theirs saves the inference cost on the resulting tokens.

## Implementation example (TypeScript)

```typescript
import { OpenAI } from "openai";
import { createHash } from "crypto";
import { readFileSync, createReadStream } from "fs";

const client = new OpenAI({
  apiKey: process.env.MOONSHOT_API_KEY,
  baseURL: "https://api.moonshot.ai/v1",
});

// 1. Local cache for extracted doc text, keyed by content hash.
// Swap the Map for Redis/Postgres in production. The point: never
// re-upload + re-extract a document you've already processed.
const extractedDocCache = new Map<string, string>();

async function getDocContent(filePath: string): Promise<string> {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (extractedDocCache.has(hash)) return extractedDocCache.get(hash)!;

  const fileObject = await client.files.create({
    file: createReadStream(filePath),
    purpose: "file-extract",
  });
  const content = await (await client.files.content(fileObject.id)).text();
  extractedDocCache.set(hash, content);

  // You're holding the text locally now — no need to keep the file
  // on Kimi's servers against the 1,000-file / 10GB account cap.
  await client.files.delete(fileObject.id);

  return content;
}

// 2. Build the stable prefix ONCE per doc set / instruction combo.
// Order and exact text must stay identical across calls that should share a hit.
async function buildStaticPrefix(docPaths: string[], systemInstructions: string) {
  const docMessages = await Promise.all(
    docPaths.map(async (path) => ({
      role: "system" as const,
      content: await getDocContent(path),
    }))
  );
  return [...docMessages, { role: "system" as const, content: systemInstructions }];
}

// 3. Ask questions against that fixed context.
async function ask(
  staticPrefix: { role: "system"; content: string }[],
  question: string,
  sessionId: string
) {
  const completion = await client.chat.completions.create({
    model: "kimi-k3",
    messages: [...staticPrefix, { role: "user", content: question }],
    prompt_cache_key: sessionId, // not yet in the SDK's TS types — see note below
  } as any);

  const usage = completion.usage as any;
  const hitRate = usage?.prompt_tokens ? (usage.cached_tokens ?? 0) / usage.prompt_tokens : 0;
  console.log(`cache hit: ${(hitRate * 100).toFixed(1)}% (${usage?.cached_tokens}/${usage?.prompt_tokens} tokens)`);

  return completion.choices[0].message.content;
}

async function main() {
  const staticPrefix = await buildStaticPrefix(
    ["./spec.pdf", "./architecture.md"],
    "You are a technical assistant. Answer only from the attached documents."
  );

  await ask(staticPrefix, "Summarize the key data flows.", "session-001");
  await ask(staticPrefix, "What are the retry semantics for the ingestion queue?", "session-001");
}

main();
```

## Monitoring cache performance

Every response — streaming or not — carries a `usage` block with `prompt_tokens`, `completion_tokens`, `total_tokens`, and `cached_tokens` (for streaming, set `stream_options: { include_usage: true }` to get it on the final chunk). Track `cached_tokens / prompt_tokens` over time as the actual hit rate — the only reliable way to confirm prefix-stability discipline is working rather than assuming it from the docs.

## Caveats & gotchas

- `prompt_cache_key` and `cached_tokens` aren't in the official `openai` npm package's TypeScript types (they're Moonshot extensions to the OpenAI-compatible schema) — hence the `as any` casts above, until Moonshot ships updated types or you write a thin wrapper type.
- No exact cache TTL is published — it's described only as system-managed. Don't assume a cache survives long idle gaps; design for back-to-back or session-clustered queries against the same doc set rather than sparse, spread-out access.
- The platform is moving fast post-launch: as of mid-July, older models like kimi-k2.5 and moonshot-v1 were already marked for retirement by August 31, so re-check the docs index before shipping anything long-lived against this API.

## Sources

- [Kimi K3 Quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Context Caching Guide](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api)
- [File-Based Q&A Guide](https://platform.kimi.ai/docs/guide/use-kimi-api-for-file-based-qa)
- [Upload File API Reference](https://platform.kimi.ai/docs/api/files-upload)
- [Create Chat Completion API Reference](https://platform.kimi.ai/docs/api/chat)
- [Kimi K3 Pricing](https://platform.kimi.ai/docs/pricing/chat-k3)
- [Model Inference Pricing Explanation](https://platform.kimi.ai/docs/pricing/chat)
- [Kimi K3 Technical Blog](https://www.kimi.com/blog/kimi-k3)
- [Docs index (llms.txt)](https://platform.kimi.ai/docs/llms.txt)
