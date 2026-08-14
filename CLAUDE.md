# foster-bridge

## Use the API, not the skills

Every trading-workflow operation goes through the NestJS backend in `backend/`.
The five skills under `.claude/skills/` are **retired** — they are hidden from
Claude by `skillOverrides` in `.claude/settings.json` and kept only as reference
documentation. Do not reimplement their CLI-and-subagent flows; call the
endpoints below instead.

## Running the backend

```bash
cd backend
pnpm install
pnpm start:dev        # watch mode; pnpm start for one-shot
```

Base URL `http://localhost:3000` (`PORT` overrides). Auth comes from GCP
Application Default Credentials — `gcloud auth application-default login` once,
project `app-foster-bridge`. Full setup in `backend/README.md`.

Health check: `GET /health`, `GET /health/ready`.

## Endpoints by workflow

Day keys are `MMDDYYYY` (matching `knowledge-base/es/<day>/`); candle dates are
`YYYY-MM-DD`.

### Benchmark — replaces `trader-bench`, `trader-panel`, `seven-keys`

```
POST /benchmark/run          body: { model?, days?: string[], runCount?,
                                     variants?: string[], regenerateKeys? }
GET  /benchmark/status       non-terminal batches (batchId, day, status, cellCount)
GET  /benchmark/scoreboard?model=<alias>
```

`POST /benchmark/run` tops up the matrix — personas × days × variants — and only
runs missing cells, so it is safe to re-issue. Omit `days` for every complete
day, omit `variants` for all declared variants, omit `model` to take
`benchmark.model` from config.

**Seven-keys generation is part of this run**, not a separate step:
`backend/src/benchmark/seven-keys/` runs the current-day analyst, lookback
analyst, synthesizer, and verifier, and only persists a verified artifact. Pass
`regenerateKeys: true` to force regeneration. The flagship model default is
provider-aware (Fable on Anthropic, Kimi K3 on Moonshot); `BENCHMARK_MODEL`
overrides. The grade-discrimination rule lives in
`backend/src/benchmark/seven-keys/prompts.ts`.

KEYS artifacts are **per-flagship lineages**: each provider flagship generates,
reuses, and looks back on only its own keys (`generatedBy` in the artifact
frontmatter names the model), so a Kimi bench never consumes Fable-generated
keys or vice versa. Within a provider, keys stay shared across run models by
design. Immutability is hash-exact — a lineage's doc freezes once a scorecard
cell pins its `contentHash` — so one flagship benchmarking a day does not block
another from generating its own keys for that day. A new lineage bootstraps its
own lookback history (expect reduced-lookback warnings on its first run), and
cross-model scoreboard rows therefore rest on different keys per provider.

Runs go through the Batch API and reconcile asynchronously — poll
`GET /benchmark/status` rather than expecting `run` to return finished cells.

### Content-drift guard

```
GET /benchmark/drift          read-only report; {} findings means clean
```

Every cell records the sha256 of the inputs it ran under (persona, general
docs, feature body, feature staticDoc). `POST /benchmark/run` compares the
current files against those hashes **before** uploading or submitting anything
and returns **409** if they disagree — otherwise an edited persona's new runs
would average into the same scoreboard row as the old persona's, since the
scoreboard groups by `(trader, alias, variant)` with no hash in the key.

Two conditions are reported: `file-drift` (a file changed after cells were
written) and `internal-drift` (existing cells disagree with each other, so a row
is *already* mixed). `GET /benchmark/drift` runs the same comparison without
submitting, for checking before spending a batch.

There is deliberately **no bypass flag**. The remedy is a new file, or reverting
the edit. Intentionally starting a new benchmark era means retiring the existing
cells — there is no endpoint for that today, so it is a manual Firestore
operation.

### Backtest — the sole judge of a setup

```
POST /backtest   body: { symbol, interval, date (YYYY-MM-DD), orders,
                         session?: 'rth'|'full', entryCutoff?, openBuffer?,
                         allowIncomplete? }
```

Never grade a setup by hand or by reading candles — this endpoint decides.

### Market data — replaces `ingest-ticker-data`

```
POST /markets/:symbol/:interval/candles?replace=true   multipart, field "file" (CSV)
GET  /markets/:symbol/:interval/days
GET  /markets/:symbol/:interval/candles?date=YYYY-MM-DD
```

### Eminiplayer ingest

```
POST /eminiplayer/ingest?date=MMDDYYYY&force=true
GET  /eminiplayer/audit?from=MMDDYYYY&to=MMDDYYYY&deep=true
```

### Costs

```
GET /costs/summary?groupBy=tier|operation|model|day|trader|variant|date&model=&from=&to=
GET /costs/records?model=&from=&to=&limit=&offset=
GET /costs/report      HTML cost dashboard
```

## Trader personas

Personas are files, not a service operation: add a `traders/*.md` directly.
Keep the `origin` / `mutation` lineage frontmatter — the scoreboard renders the
family tree from those fields. Trader files are **immutable once benchmarked**:
refining a persona means a new file, never an edit to an existing one, so that
recorded cells keep meaning what they meant when they ran. The backend enforces
this — see the drift guard below. `.claude/skills/trader-spawn/SKILL.md` still
documents the conventions.

Never carry a persona list over from a previous run or a previous message; the
set on disk is the only source of truth.
