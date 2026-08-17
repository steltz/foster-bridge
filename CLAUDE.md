# foster-bridge

## Use the API, not the skills

Every trading-workflow operation goes through the NestJS backend in `backend/`.
The five trading skills that lived under `.claude/skills/` are **retired and
deleted**. Do not reimplement their CLI-and-subagent flows; call the endpoints
below instead. All benchmark content — personas, features, knowledge docs, day
inputs — lives in Firebase Storage/Firestore, not in this repo. The
`data/persona-*.md` files are retired archives of old personas, never benchmark
inputs; the rest of `data/` (the `ES_*` txt files) are raw candle sources for
`POST /markets/ingest-contracts`.

## Running the backend

```bash
cd backend
pnpm install
pnpm start:dev        # watch mode; pnpm start for one-shot
```

Base URL `http://localhost:3000` (`PORT` overrides). Auth comes from GCP
Application Default Credentials — `gcloud auth application-default login` once,
project `app-foster-bridge`. ADC covers Firebase only: LLM calls (benchmark
runs, seven-keys, transcript verification) need `ANTHROPIC_API_KEY` in
`backend/.env` — or `LLM_PROVIDER=moonshot` plus `MOONSHOT_API_KEY`.
`LLM_PROVIDER` is the provider switch behind the flagship default; unset/empty
means anthropic. Full setup in `backend/README.md`.

Health check: `GET /health`, `GET /health/ready`. Readiness is reported in the
body (`status: "ok" | "degraded"`), always HTTP 200 — check the body, not the
status code.

## Endpoints by workflow

Day keys are `MMDDYYYY`; candle dates are `YYYY-MM-DD`; intervals are `min-1` |
`min-5` | `min-15` (note: `min-1`, not `1min` as in the `data/` filenames).

### Benchmark — replaces `trader-bench`, `trader-panel`, `seven-keys`

```
POST /benchmark/run          body: { model?, days?: string[], runCount?,
                                     variants?: string[], regenerateKeys? }
GET  /benchmark/status       non-terminal batches (batchId, day, status, cellCount)
GET  /benchmark/scoreboard?model=<alias|id>   omit model for benchmark.model;
                                              404 until a run has produced cells
POST /benchmark/samples        body: { name (lowercase slug: [a-z0-9-], ≤64),
                                       count? (default 100), from?, to? (MMDDYYYY) }
                               draws a write-once random sample of benchmarkable
                               days (committed manifests ∩ complete candle days);
                               409 if the name exists, 422 if count exceeds the
                               eligible pool
GET  /benchmark/samples        list sample summaries
GET  /benchmark/samples/:name  full day list
```

On `POST /benchmark/run`, `sample: "<name>"` pins the run to a persisted
sample's days (mutually exclusive with `days`; resolved before the run lock, so
bad requests 400/404/422 (empty sample) instead of 409). The run also 422s if
Firestore has no personas or no features — create them via `POST /traders` /
`POST /features` first.

Corpus-wide KEYS generation — build the lookback chain before benchmarking:

```
POST   /benchmark/keys-backfill?confirm=true&from=MMDDYYYY&to=MMDDYYYY   202, detached; omit from/to for the whole committed corpus
GET    /benchmark/keys-backfill                                          snapshot + progress/ETA + reducedLookback; 404 if none since boot
DELETE /benchmark/keys-backfill?startedAt=<iso>                          cancel; the in-flight attempt finishes (a mid-retry cancel ends that day early); 409 if startedAt does not match
```

**Sequence: era-reset script → keys-backfill to completion → benchmark runs.**
Running the backfill without `backend/scripts/reset-keys-era.mjs` silently
reuses the 11 already-pinned artifacts, 4 of which have degraded lookback.

Sequential and oldest-first so every day gets a full 3-day lookback — which a
sampled run cannot provide, because a sample's scattered days almost never have
KEYS for their 3 prior days. A day is reused only when its artifact is
`verified` **and** has an empty `lookbackMissing`. Failures are classified
(`unverified` / `error` / `refused` / `timeout`); `unverified` and `error` retry
up to 3 times with backoff, `refused` and `timeout` stop immediately, and any
stop ends the job (`state: "failed"`, `failures[0]` names the day) rather than
leaving a hole. Re-POST resumes — built days short-circuit on one read.

`POST /benchmark/keys-backfill` and `POST /benchmark/run` are **mutually
exclusive**: whichever starts first holds a shared lock, the other gets 409 with
a `holder` field. Assumes a single backend process. Do not run eminiplayer
ingest/backfill concurrently — a re-ingest of any corpus day stops the job by
design. Run against a one-shot server (`pnpm start`), never watch mode: job
state is in-memory. Budget ~$130 and 20-40 hours for a cold corpus (352
committed days at ~$0.37/day).

Operator notes:
- Before the era reset, confirm the script's lineage matches the backend's:
  `KEYS_LINEAGE` (default `k3`) must equal the `flagshipAlias` in the
  backfill's GET snapshot, or the reset clears one lineage while the backfill
  builds another.
- The reset script runs `dist/`, so `pnpm build` first.
- Do not start or re-POST the backfill while `GET /benchmark/status` shows
  non-terminal batches — the job refuses to start (job-level `failed`),
  because regenerating a day an unreconciled batch pinned would wedge it.
- If the job sticks at `running` with no progress and DELETE seems ignored,
  it is hung in an unguarded read: restart the process and re-POST — built
  days short-circuit.

`POST /benchmark/run` tops up the matrix — personas × days × variants — and only
runs missing cells, so it is safe to re-issue. It is **single-flight**: a second
`POST` while a run is in progress returns 409 — note `POST /benchmark/run` has
three 409 causes — a run in progress, a keys backfill in progress (both name
the `holder`; check `GET /benchmark/status` and `GET /benchmark/keys-backfill`),
vs content drift (check `GET /benchmark/drift`) — and the response body says
which. Omit
`days` for every complete day, omit `variants` for the configured default
(`benchmark.defaultVariants`, env `BENCHMARK_VARIANTS`, comma-separated —
ships as `seven-keys-scorecard` only; pass `variants` explicitly to run
base/method), omit `model` to take `benchmark.model` from config, omit
`runCount` for the configured default (`benchmark.defaultRunCount`, env
`BENCHMARK_RUN_COUNT`, ships as 5 runs per cell).

Day availability comes from committed eminiplayer manifests in the bucket —
`POST /eminiplayer/ingest` is how a day becomes benchmarkable.

**Seven-keys generation is part of this run**, not a separate step:
`backend/src/benchmark/seven-keys/` runs the current-day analyst, lookback
analyst, synthesizer, and verifier, and only persists a verified artifact. Pass
`regenerateKeys: true` to force regeneration — pre-freeze only: a day whose
KEYS are pinned by scorecard cells (persisted or in a submitted, unreconciled
batch) reuses the frozen doc regardless. A failed generation or verifier fail
persists nothing and skips only that day's scorecard cells — the run response
lists the day under `daysSkipped` (reason `keys generation failed`); re-POST
retries it. The flagship model default is provider-aware (Fable on Anthropic,
Kimi K3 on Moonshot); `BENCHMARK_MODEL` overrides. The grade-discrimination
rule lives in `backend/src/benchmark/seven-keys/prompts.ts`.

KEYS artifacts are **per-flagship lineages**: each provider flagship generates,
reuses, and looks back on only its own keys (`generatedBy` in the artifact
frontmatter names the model), so a Kimi bench never consumes Fable-generated
keys or vice versa. Within a provider, keys stay shared across run models by
design. Immutability is hash-exact — a lineage's doc freezes once a scorecard
cell pins its `contentHash` — so one flagship benchmarking a day does not block
another from generating its own keys for that day. A new lineage bootstraps its
own lookback history (expect reduced-lookback warnings on its first run), and
cross-model scoreboard rows therefore rest on different keys per provider.

The benchmark grades against ES min-1 at real $50/pt, and each cell records
`result.contract` (the quarterly it actually ran on). Grading stamps harness
constants on every order (`benchmark.grading`): qty 2, take half at +1.5R and
move the stop to breakeven (`BENCHMARK_MGMT=off` disables management), and
setups below 2:1 reward-to-risk are recorded INVALID without backtesting
(`BENCHMARK_RR_FLOOR`). These are env-tunable — `BENCHMARK_RR_FLOOR` (2),
`BENCHMARK_QTY` (2), management `BENCHMARK_MGMT_TRIGGER_R`/`TAKE_FRACTION`/
`MOVE_STOP_TO_R` (1.5/0.5/0); see `docs/order-contract-v2.md`. Each cell
records the regime it was graded under, but the drift guard does NOT check it
and the scoreboard groups with no regime in the key — changing these mid-era
mixes grading regimes into existing scoreboard rows without a 409, so leave
them alone within an era.

Runs go through the Batch API and reconcile asynchronously — poll
`GET /benchmark/status` rather than expecting `run` to return finished cells.
Reconciliation is an in-process scheduler (every-minute cron plus a boot-time
sweep) on the same server — keep a server running until `GET /benchmark/status`
empties, or cells and the scoreboard never materialize. Batch state is in
Firestore, so restarts resume via the boot sweep. `BENCHMARK_SCHEDULER=false`
disables the scheduler entirely (worker-split deploys); the scoreboard is
rebuilt only by the reconciler, so it refreshes only when batches reconcile.

The `/ai/*` routes (`backend/src/demo/`) are raw Anthropic connectivity demos —
never use `POST /ai/batch` or `GET /ai/batch/:id` for benchmark work. Benchmark
batches are submitted and reconciled only by the benchmark pipeline;
`GET /benchmark/status` is the one way to watch them.

### Content-drift guard

```
GET /benchmark/drift          read-only report { findings, cellsExamined };
                              empty findings array means clean
```

Every cell records the sha256 of the inputs it ran under (persona, general
docs, feature body, feature staticDoc). `POST /benchmark/run` compares the
current stored content against those hashes **before** uploading or submitting
anything and returns **409** if they disagree — otherwise an edited persona's new runs
would average into the same scoreboard row as the old persona's, since the
scoreboard groups by `(trader, alias, variant)` with no hash in the key.

Two conditions are reported: `file-drift` (content changed after cells were
written) and `internal-drift` (existing cells disagree with each other, so a row
is *already* mixed). `GET /benchmark/drift` runs the same comparison without
submitting, for checking before spending a batch.

There is deliberately **no bypass flag**. The remedy is a new doc, or reverting
the edit. Intentionally starting a new benchmark era means retiring the existing
cells — there is no endpoint for that today, so it is a manual Firestore
operation.

### Content endpoints

Benchmark inputs are cloud docs, managed through the API:

```
POST /traders                    create a persona (write-once; 409 if the name exists)
POST /features                   create a feature (write-once, keyed by frontmatter
                                 `id` — 400 if missing, 409 if the id exists)
PUT  /knowledge/general/:name    upsert a general knowledge doc
PUT  /knowledge/methods          upsert the methods doc
GET  /traders                    list personas
GET  /features                   list features
GET  /knowledge/general          list general docs
```

All bodies are `{ content: "<markdown with frontmatter>" }`. Features key on
frontmatter `id` (required — `name` is display-only); personas key on
frontmatter `name`. Persona `name`, feature `id`, and general-doc `:name` must
match `[A-Za-z0-9_-]+` — anything else 400s. The methods doc has exactly **one
copy** (`PUT /knowledge/methods`); features reference it live via their
`staticDoc` frontmatter rather than embedding a duplicate.

List endpoints return metadata + sha256 only — no endpoint returns a doc's
content. To read an existing persona/feature (e.g. as the base for a refined
persona under a new name) or the current methods doc, read Firestore
(`traders`/`features` collections, `content` field) or the bucket
(`knowledge-base/...`) directly.

### Backtest — the sole judge of a setup

```
POST /backtest   body: { symbol, interval, date (YYYY-MM-DD), orders,
                         session?: 'rth'|'full', entryCutoff?, openBuffer?,
                         allowIncomplete? }
```

Never grade a setup by hand or by reading candles — this endpoint decides.

`orders` is an array of `{ side: 'long'|'short', entry, stopLoss, takeProfit,
id?, qty?, activeFrom? ('HH:MM'), management? }`; prices must satisfy
stopLoss < entry < takeProfit for longs (mirrored for shorts) or the request
400s. Full contract in `docs/order-contract-v2.md`.

Defaults: `session` 'rth', `openBuffer` 30, `entryCutoff` '14:00'
(contract-local time; ET for ES). An unfilled order is not eligible for entry
in the first `openBuffer` minutes after RTH open or at/after `entryCutoff` — it
silently never fills, no error. Pass `entryCutoff: 'off'` to remove the cutoff
and `openBuffer: 0` to allow entries from the open. With `session: 'rth'` (the
default), incomplete RTH data returns 422 unless `allowIncomplete: true`.

Errors: 404 = no stored candles for that contract/interval/date (ingest first)
or unknown symbol; 422 `incomplete-session` = the RTH session has gaps — pass
`allowIncomplete: true` only if a partial day is acceptable, otherwise ingest
the missing candles.

`symbol: "ES"` auto-resolves the quarterly contract for the given date (roll
rule: switches on the Monday of expiration week — see
`docs/es-contract-roll-convention.md`). Explicit quarterlies like `ESU26` are
accepted as-is. The response includes `contract` naming what actually ran.

### Market data — replaces `ingest-ticker-data`

```
POST /markets/:symbol/:interval/candles?replace=true   multipart, field "file" (CSV)
GET  /markets/:symbol/:interval/days
GET  /markets/:symbol/:interval/candles?date=YYYY-MM-DD
POST /markets/ingest-contracts    202, detached job; walks data/ES_{1min,5min}_{archive,update}_* per-contract txt files (root = repo root; CONTRACT_DATA_ROOT overrides); 409 if running, 422 if no files found
GET  /markets/ingest-contracts    job snapshot ({state:'idle'} if never run)
```

The candle store is keyed per contract (`markets/ESU26/min-1/...`). Upload CSVs
under the quarterly symbol (`POST /markets/ESU26/min-1/candles`), never `ES` —
the upload path does no roll-resolution, so base-symbol uploads land in a
`markets/ES/...` store that backtests (which resolve `ES` to the quarterly)
never read. Run the contract ingest from a one-shot server (`pnpm start`),
never watch mode — job state is in-memory, so a restart shows `idle` = job
died; re-POST is safe/idempotent.

### Eminiplayer ingest

```
POST /eminiplayer/ingest?date=MMDDYYYY&force=true
GET  /eminiplayer/audit?from=MMDDYYYY&to=MMDDYYYY&deep=true
```

Ingest and backfill log in to eminiplayer.net — `EMINIPLAYER_USERNAME` /
`EMINIPLAYER_PASSWORD` must be set in `backend/.env` (empty = unconfigured; the
run throws). `EMINIPLAYER_HEADLESS=false` shows the browser for debugging.

Errors on `POST /eminiplayer/ingest`: 400 = missing/invalid date param; 404 =
archive has no trade-plan entry for that day, or no recap within the 14-day
lookback window (not a routing problem); 422 = fetched data failed validation —
not retryable as-is, a human must look; 502 = a pipeline stage failed upstream —
safe to re-POST, already-uploaded artifacts resume via fill-and-skip.

Bulk backfill — a detached multi-day job over the same pipeline:

```
POST   /eminiplayer/backfill?from=MMDDYYYY&to=MMDDYYYY   202, detached job; `to` defaults to today (ET); 409 with the live job snapshot if one is already running; once idle, committed days short-circuit on re-POST
GET    /eminiplayer/backfill                             current/last job snapshot (ledger, counts, cancelRequested); 404 if no job has run since boot (in-memory state — no idle sentinel, unlike ingest-contracts)
DELETE /eminiplayer/backfill                              request cancellation; in-flight day finishes first; 404 if no job has run since boot
```

Like the contract ingest, backfill job state is in-memory — run multi-hour
backfills against a one-shot server (`pnpm start`), never watch mode, or a
file-change restart silently kills the job (committed days survive; re-POST
resumes past them).

Optional `EMINIPLAYER_BACKFILL_TOKEN` guards `POST`/`DELETE` via an `x-backfill-token`
header; empty/unset means unguarded.

```
POST /eminiplayer/prune?from=MMDDYYYY&to=MMDDYYYY&apply=true
```

Sweeps storage artifacts of never-committed days (no `manifest.json`); committed
days are never touched. Dry-run report by default — only `apply=true` deletes,
needs the backfill token (when configured), and 409s while a backfill is
running (the in-flight day's uncommitted uploads look like orphans), so wait
for the job to finish; dry-run is unguarded and responds anytime, but may list
that day's artifacts.

### Costs

```
GET /costs/summary?groupBy=tier|operation|model|day|trader|variant|date&model=&from=&to=
GET /costs/records?model=&from=&to=&limit=&offset=   limit default 100, max 1000; returns { total, records }
GET /costs/report?model=&from=&to=      HTML cost dashboard (same filters)
```

`from`/`to` are ISO-timestamp bounds compared lexically — use `YYYY-MM-DD` (or
a full ISO timestamp), never `MMDDYYYY`; `from` is inclusive, `to` exclusive,
so `to=2026-08-16` excludes that day. `model` matches the record's model alias
(the benchmark/scoreboard alias for benchmark runs; the raw model id
otherwise).

## Trader personas — replaces `trader-spawn`

Personas are **write-once Firestore docs**, created via `POST /traders` — no
live persona files in the repo, only retired archives under `data/`.
Frontmatter requires `name`; `origin` and `mutation` are optional for root
personas and are recorded as lineage when present — the scoreboard renders the
family tree from those fields. Write-once means refining a persona is a **new
name, never an edit** to an existing doc, so that recorded cells keep meaning
what they meant when they ran.

`GET /traders` lists the current set. Never carry a persona list over from a
previous run or a previous message; Firestore is the only source of truth.
