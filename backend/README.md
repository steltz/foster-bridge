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
pnpm test:e2e    # e2e: health, market-data ingest/read, backtest (in-memory Firestore fake)
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

## Market data & backtest

Endpoints for ingesting OHLC candle data and running a simple long/short
backtest against it.

### Supported symbols & intervals

| Symbol | Point value |
| --- | --- |
| MES | 5 |
| ES | 50 |
| NQ | 20 |
| MNQ | 2 |

Intervals: `min-1`, `min-5`, `min-15` — only intervals that evenly divide the
390-minute RTH window (09:30–16:00 ET), so completeness is always a whole
number of bars. `min-60` is intentionally unsupported (6.5 hours doesn't
divide evenly into hourly bars). Uploaded candle timestamps must align to the
interval grid.

### Ingest candles

```bash
curl -X POST "localhost:3000/markets/MES/min-5/candles" \
  -F file=@mes-2026-07.csv
```

Multipart `file` field, CSV with header `time,open,high,low,close` (`time` is
Unix epoch seconds). Add `?replace=true` to overwrite existing rows for a day
instead of merging. The response is an ingest summary, one entry per calendar
day found in the file:

```json
{
  "totalRows": 78,
  "days": [
    { "date": "2026-07-14", "added": 78, "updated": 0, "unchanged": 0, "totalAfter": 78, "complete": true }
  ]
}
```

Ingestion is idempotent per day: re-uploading the same file merges by
timestamp (dedup on `time`), so repeated uploads of overlapping data don't
duplicate candles.

### Read back candles

```bash
# Stored days for a symbol/interval, with bar count and RTH completeness
curl localhost:3000/markets/MES/min-5/days
# -> [{ "date": "2026-07-14", "count": 78, "complete": true }, ...]

# A single day's candles
curl "localhost:3000/markets/MES/min-5/candles?date=2026-07-14"
```

### Backtest

```bash
curl -X POST localhost:3000/backtest \
  -H 'content-type: application/json' \
  -d '{
    "symbol": "MES",
    "interval": "min-5",
    "date": "2026-07-14",
    "session": "rth",
    "orders": [{ "side": "long", "entry": 100, "stopLoss": 95, "takeProfit": 110 }]
  }'
```

Request body:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `symbol` | string | — | one of MES/ES/NQ/MNQ |
| `interval` | string | — | one of `min-1`/`min-5`/`min-15` |
| `date` | string | — | `YYYY-MM-DD`, ET calendar day |
| `session` | `'rth' \| 'full'` | `'rth'` | which candles to simulate over |
| `orders` | array | — | one or more `{ side, entry, stopLoss, takeProfit }` |
| `entryCutoff` | `'HH:MM' \| 'off'` | `'14:00'` | stop looking for a fill after this ET time; `'off'` disables the cutoff |
| `openBuffer` | number (minutes) | `30` | delay order activation this many minutes past RTH open |
| `allowIncomplete` | boolean | `false` | bypass the incomplete-session gate below |

Response: `{ symbol, date, session, results, summary, coverage }` — per-order
fill/exit `results`, an aggregate `summary` (e.g. `orders` count), and a
`coverage` report (`complete`, `hasOpen`, `hasClose`, `gaps`).

If `session` is `'rth'` and the stored day doesn't have full RTH coverage
(missing open/close bar or gaps), the request is refused with **422**:

```json
{ "error": "incomplete-session", "message": "...", "hasOpen": true, "hasClose": false, "gaps": [...] }
```

Pass `allowIncomplete: true` to run the backtest anyway.

### Known limitation: half-days

Early-close (half) trading days never satisfy the full RTH bar count, so
today they're always flagged `complete: false` and are excluded from
backtesting under the default `'rth'` session gate (use `allowIncomplete:
true` or `session: 'full'` to work around it). There is no half-day calendar
yet to special-case these dates.

## EminiPlayer scraper (Playwright)

`src/eminiplayer/` provides `EminiplayerService.openArchivePage()`, which
drives a Playwright Chromium browser to https://www.eminiplayer.net/archive.aspx,
logging in first when the site shows its login link. It returns
`{ url, title, screenshotPath }` and saves a full-page screenshot under
`artifacts/eminiplayer/` (git-ignored). No content parsing yet.

Setup:

1. `pnpm exec playwright install chromium` (one-time browser download)
2. Set `EMINIPLAYER_USERNAME` / `EMINIPLAYER_PASSWORD` in `.env`
   (see `.env.example`; `EMINIPLAYER_HEADLESS=false` shows the browser)

Manual smoke test — hits the live site. Prerequisites: credentials in `.env`
and working GCP ADC (booting the app context initializes the Firebase
module). `BENCHMARK_SCHEDULER=false` keeps the benchmark reconciler/crons
from touching Firestore as a side effect:

    BENCHMARK_SCHEDULER=false pnpm exec ts-node -e "const { NestFactory } = require('@nestjs/core'); \
    const { AppModule } = require('./src/app.module'); \
    const { EminiplayerService } = require('./src/eminiplayer/eminiplayer.service'); \
    (async () => { \
      const app = await NestFactory.createApplicationContext(AppModule); \
      console.log(await app.get(EminiplayerService).openArchivePage()); \
      await app.close(); \
    })();"
