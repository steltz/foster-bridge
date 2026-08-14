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

Runs go through the Batch API and reconcile asynchronously — poll
`GET /benchmark/status` rather than expecting `run` to return finished cells.

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
family tree from those fields. Treat a trader file as **immutable once
benchmarked**: refining a persona means a new file, never an edit to an existing
one, so that recorded cells keep meaning what they meant when they ran. This is
a convention, not something the backend enforces — the old `trader-bench` skill
hash-guarded it and the port did not carry that guard over.
`.claude/skills/trader-spawn/SKILL.md` still documents the conventions.

Never carry a persona list over from a previous run or a previous message; the
set on disk is the only source of truth.
