# foster-bridge backend

NestJS service connecting to Firebase **Firestore** and **Storage** using GCP
**Application Default Credentials (ADC)** — no service-account key files.

## Prerequisites

- Node ≥ 20, pnpm
- Google Cloud SDK (`gcloud`)
- Access to the `app-foster-bridge` GCP/Firebase project

## One-time ADC setup

```bash
gcloud auth application-default login
gcloud config set project app-foster-bridge
```

This writes Application Default Credentials to the well-known local path that
`firebase-admin` reads automatically. The app passes **no** `credential`
argument to `initializeApp`, so it relies entirely on ADC. In GCP (Cloud Run,
GCE, etc.) the attached service identity supplies ADC with no login step.

## Configuration

Copy `.env.example` to `.env` and adjust if needed (defaults target
`app-foster-bridge`). `.env` is gitignored.

| Var | Default |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `app-foster-bridge` |
| `FIREBASE_STORAGE_BUCKET` | `app-foster-bridge.firebasestorage.app` |
| `PORT` | `3000` |

## Run

```bash
pnpm install
pnpm start:dev   # watch mode
```

## Smoke-test ADC connectivity

With the app running:

```bash
# Liveness (no external calls)
curl localhost:3000/health

# Readiness — live Firestore + Storage round-trip via ADC
curl localhost:3000/health/ready

# Firestore demo
curl -X POST localhost:3000/demo/firestore -H 'content-type: application/json' -d '{"message":"hi"}'
curl localhost:3000/demo/firestore

# Storage demo
curl -X POST localhost:3000/demo/storage -H 'content-type: application/json' -d '{"content":"hi","name":"a.txt"}'
curl localhost:3000/demo/storage
curl localhost:3000/demo/storage/a.txt/url
```

`/health/ready` should report `{ "status": "ok", "dependencies": { "firestore": "ok", "storage": "ok" } }`
once ADC is configured and the principal has Firestore + Storage access.

`/health/ready` is a **diagnostic** probe: it always returns HTTP `200` and
reports health in the body (`status: "ok" | "degraded"`, plus per-dependency
`ok`/`error`). The readiness signal is the body, not the status code. If you
wire this as an orchestrator readiness probe (Cloud Run, k8s) that gates on the
HTTP status, change the handler to return `503` when `status` is `degraded`.

### Note on signed URLs under user ADC

`GET /demo/storage/:name/url` generates a v4 signed URL, which requires blob
signing. When running under **user** ADC (`gcloud auth application-default
login`), user accounts cannot sign blobs directly; the call may fail with a
signing/permission error. This works out of the box when running under a
**service identity** (e.g. Cloud Run) or when a signing service account is
configured. The global exception filter surfaces this as a clean 403/500 rather
than a stack trace — expected in local user-ADC environments.

## Tests

```bash
pnpm test        # unit tests (SDK mocked, no network)
pnpm test:e2e    # e2e: GET /health
```

Live GCP connectivity is verified manually via `/health/ready`, not in CI.

## Claude (Anthropic) client

An `AnthropicModule` wraps `@anthropic-ai/sdk` and exposes demo endpoints under
`/ai`. The SDK client is constructed **lazily** on first use, so the app boots
and all tests pass without an API key.

### Configuration

| Var | Default |
| --- | --- |
| `ANTHROPIC_API_KEY` | *(unset)* — add when you have one |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` |
| `ANTHROPIC_MAX_TOKENS` | `4096` |

### Endpoints

```bash
# Config check — no live call; works before a key is added
curl localhost:3000/ai/ready
# -> { "configured": false }   (true once ANTHROPIC_API_KEY is set)

# Single message
curl -X POST localhost:3000/ai/message \
  -H 'content-type: application/json' \
  -d '{"prompt":"Say hi in one word"}'

# Batch: submit, poll, fetch results
curl -X POST localhost:3000/ai/batch \
  -H 'content-type: application/json' \
  -d '{"requests":[{"prompt":"1+1?"},{"customId":"q2","prompt":"2+2?"}]}'
curl localhost:3000/ai/batch/<batchId>
curl localhost:3000/ai/batch/<batchId>/results   # 409 until the batch has ended
```

The Message Batches API processes requests asynchronously at 50% of standard
price; most batches finish within an hour. Results are keyed by `customId` and
arrive in any order.

### Smoke-test with a real key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm start:dev
curl -X POST localhost:3000/ai/message -H 'content-type: application/json' \
  -d '{"prompt":"Say hi"}'
```

Without a key, `/ai/message` and the batch routes return `401` (from
`ANTHROPIC_API_KEY is not configured`); `/ai/ready` still returns 200.
