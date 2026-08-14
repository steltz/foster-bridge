# EminiPlayer Bulk Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-running in-process backfill job (`POST/GET/DELETE /eminiplayer/backfill`) that ingests every trade-plan day in a date range through the existing single-day pipeline, scraping the archive listing once per job.

**Architecture:** Three small seams on existing code (a pure `listTradePlanDates`, an extracted `EminiplayerService.fetchArchiveRows`, an optional `resolvedEntries` parameter on `EminiplayerIngestService.ingest`) plus one new `EminiplayerBackfillService` owning an in-memory singleton job with a per-day failure ledger, and three thin controller routes. No persistence: per-day manifests already make re-POST resume free.

**Tech Stack:** NestJS 10, Jest, Playwright (already wired), TypeScript. All commands run from `backend/`.

**Spec:** `docs/superpowers/specs/2026-08-14-eminiplayer-bulk-backfill-design.md`

## Global Constraints

- Semantic commit messages; **no Claude attribution lines** in commits (user rule).
- TDD every change: failing test first, watch it fail, minimal code, watch it pass.
- Dates are `MMDDYYYY` strings everywhere in this module; listing row dates are ISO `YYYY-MM-DD`.
- Default backfill delay: **2000 ms**, env `EMINIPLAYER_BACKFILL_DELAY_MS`, config key `eminiplayer.backfillDelayMs`.
- Job snapshot field names exactly as in the spec: `state/from/to/startedAt/finishedAt/currentDate/counts{candidates,processed,uploaded,skipped,failed}/failures[{date,kind,message}]/error`.
- Failure kinds exactly: `notFound | validation | stage | unknown`.
- Run tests with `pnpm exec jest <pattern>`; full suite must stay green after every task.

---

### Task 1: `listTradePlanDates` (pure candidate derivation)

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-archive.ts` (append at end of file)
- Test: `backend/src/eminiplayer/eminiplayer-archive.spec.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `RawArchiveRow`, `classifyArchiveTitle`, the module-private `rowDateToMmddyyyy`, `parseMmddyyyy` (already imported in this file).
- Produces: `listTradePlanDates(rows: RawArchiveRow[], from: string, to: string): string[]` — deduped trade-plan dates in `[from, to]` inclusive, ascending `MMDDYYYY[]`.

- [ ] **Step 1: Write the failing tests** — append to `eminiplayer-archive.spec.ts` (import `listTradePlanDates` from `./eminiplayer-archive` alongside the existing imports):

```ts
describe('listTradePlanDates', () => {
  const row = (dateText: string, href: string, title: string): RawArchiveRow => ({
    dateText,
    href,
    title,
  });

  const rows: RawArchiveRow[] = [
    row('2026-01-02', '/post/a.aspx', 'ES Key Zones and Trade Plan for Friday 01/02/2026'),
    row('2025-12-30', '/post/b.aspx', 'ES Key Zones and Trade Plan for Tuesday 12/30/2025'),
    row('2025-12-30', '/post/b2.aspx', 'ES Key Zones and Trade Plan for Tuesday 12/30/2025'), // dup date
    row('2025-12-30', '/post/r.aspx', 'ES Recap (Video Lesson) for Tuesday 12/30/2025'), // recap, not TP
    row('2025-12-29', '/post/c.aspx', 'ES Key Zones and Trade Plan for Monday 12/29/2025'),
    row('Date', '/post/x.aspx', 'ES Key Zones and Trade Plan for Monday 12/29/2025'), // malformed cell
    row('2025-12-24', '/post/d.aspx', "Zones and Trade Plans Will Resume When I'm Back"), // announcement
  ];

  it('returns deduped TP dates in [from, to] inclusive, ascending across a year boundary', () => {
    expect(listTradePlanDates(rows, '12292025', '01022026')).toEqual([
      '12292025',
      '12302025',
      '01022026',
    ]);
  });

  it('range bounds are inclusive and exclude everything outside', () => {
    expect(listTradePlanDates(rows, '12302025', '12302025')).toEqual(['12302025']);
  });

  it('ignores recap rows, announcements, and malformed date cells', () => {
    // only the announcement + malformed rows fall in this range
    expect(listTradePlanDates(rows, '12202025', '12242025')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer-archive.spec -t listTradePlanDates`
Expected: FAIL — `listTradePlanDates` is not exported.

- [ ] **Step 3: Implement** — append to `eminiplayer-archive.ts`:

```ts
/**
 * All trade-plan dates in [from, to] (inclusive, MMDDYYYY), deduped and
 * ascending — the bulk backfill's candidate list, derived from ONE listing
 * scrape. Rows that fail classification or have malformed date cells are
 * skipped, exactly as selectDayEntries skips them; per-day agreement checks
 * run later, when each day is actually processed.
 */
export function listTradePlanDates(rows: RawArchiveRow[], from: string, to: string): string[] {
  const fromT = parseMmddyyyy(from).getTime();
  const toT = parseMmddyyyy(to).getTime();
  const dates = new Set<string>();
  for (const raw of rows) {
    const rowDate = rowDateToMmddyyyy(raw.dateText);
    if (!rowDate) continue;
    if (classifyArchiveTitle(raw.title)?.kind !== 'tradePlan') continue;
    const t = parseMmddyyyy(rowDate).getTime();
    if (t < fromT || t > toT) continue;
    dates.add(rowDate);
  }
  return [...dates].sort((a, b) => parseMmddyyyy(a).getTime() - parseMmddyyyy(b).getTime());
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm exec jest eminiplayer-archive.spec`
Expected: all green (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/eminiplayer-archive.ts src/eminiplayer/eminiplayer-archive.spec.ts
git commit -m "feat(eminiplayer): listTradePlanDates candidate derivation for bulk backfill"
```

---

### Task 2: Extract `EminiplayerService.fetchArchiveRows()`

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer.service.ts` (the `findDayEntries` method)
- Test: `backend/src/eminiplayer/eminiplayer.service.spec.ts` (append to the `findDayEntries` describe)

**Interfaces:**
- Consumes: existing `gotoAuthenticated`, `assertOnArchivePage`, `SELECTORS.archiveRows`, `selectDayEntries`.
- Produces: `EminiplayerService.fetchArchiveRows(): Promise<RawArchiveRow[]>` — one authenticated listing scrape. `findDayEntries(date)` behavior unchanged.

- [ ] **Step 1: Write the failing test** — inside the existing `describe('findDayEntries', …)` block (it already defines `LISTING_ROWS` and `makePage`/`build`):

```ts
  it('fetchArchiveRows scrapes the authenticated listing once and returns raw rows', async () => {
    const page = makePage({ $$eval: jest.fn(() => Promise.resolve(LISTING_ROWS)) });
    const { service } = await build(page);
    const rows = await service.fetchArchiveRows();
    expect(page.goto).toHaveBeenCalledWith(ARCHIVE_URL, expect.anything());
    expect(page.$$eval).toHaveBeenCalledWith(SELECTORS.archiveRows, expect.any(Function));
    expect(rows).toEqual(LISTING_ROWS);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer.service.spec -t fetchArchiveRows`
Expected: FAIL — `service.fetchArchiveRows is not a function`.

- [ ] **Step 3: Implement** — in `eminiplayer.service.ts`, replace the body of `findDayEntries` and add the new method (imports of `RawArchiveRow` come from `./eminiplayer-archive`, which the file already imports from):

```ts
  /**
   * One authenticated scrape of the archive listing's raw rows. Extracted from
   * findDayEntries so the bulk backfill can scrape ONCE and derive every day's
   * entries from the same capture (the listing is 1.7 MB — re-downloading it
   * per day tripled the site footprint).
   */
  async fetchArchiveRows(): Promise<RawArchiveRow[]> {
    return this.playwright.withPage(async (page) => {
      await this.gotoAuthenticated(
        page,
        ARCHIVE_URL,
        'navigating to archive.aspx',
      );
      this.assertOnArchivePage(page);
      return page.$$eval(SELECTORS.archiveRows, (trs) =>
        trs.map((tr) => {
          const anchor = tr.querySelector('td.title a');
          return {
            dateText: tr.querySelector('td.date')?.textContent?.trim() ?? '',
            href: anchor?.getAttribute('href') ?? '',
            title: anchor?.textContent?.trim() ?? '',
          };
        }),
      );
    });
  }

  /**
   * Scan the archive listing for the trade-plan entry dated `date` (MMDDYYYY)
   * and the most recent recap entry dated strictly before it. Row selection,
   * three-way date agreement, and the RECAP_LOOKBACK_DAYS bound live in
   * eminiplayer-archive.ts (selectDayEntries). Throws ArchiveNotFoundError
   * when the day (or its recap) is not in the archive — the controller maps
   * that to 404.
   */
  async findDayEntries(date: string): Promise<DayEntries> {
    const rows = await this.fetchArchiveRows();
    return selectDayEntries(rows, date, ARCHIVE_URL);
  }
```

Update the import line to include the type: `import { resolveEntryUrl, selectDayEntries, RawArchiveRow } from './eminiplayer-archive';`

- [ ] **Step 4: Run and watch everything pass** (the existing `findDayEntries` tests must stay green unmodified)

Run: `pnpm exec jest eminiplayer.service.spec`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/eminiplayer.service.ts src/eminiplayer/eminiplayer.service.spec.ts
git commit -m "refactor(eminiplayer): extract fetchArchiveRows from findDayEntries"
```

---

### Task 3: `resolvedEntries` seam on `EminiplayerIngestService.ingest`

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-ingest.service.ts` (the `ingest` and `run` methods)
- Test: `backend/src/eminiplayer/eminiplayer-ingest.service.spec.ts`

**Interfaces:**
- Consumes: `DayEntries` from `./eminiplayer.constants`.
- Produces: `ingest(date: string, force?: boolean, resolvedEntries?: DayEntries): Promise<IngestResult>` — with entries provided, `eminiplayer.findDayEntries` is never called; everything downstream unchanged.

- [ ] **Step 1: Write the failing test** — append inside `describe('EminiplayerIngestService.ingest', …)` (the builder exposes `eminiplayer` with a `findDayEntries` mock; `DATE`, `RECAP_DATE`, and the entry constants already exist at the top of the file — reuse the same shapes the default `findDayEntries` mock resolves to):

```ts
  it('with resolvedEntries: skips archive resolution and feeds the entries into the pipeline', async () => {
    const { service, eminiplayer, manifest } = await build();
    // capture what the default mock would have resolved, then hand it in directly
    const entries = await eminiplayer.findDayEntries.getMockImplementation()!(DATE);
    eminiplayer.findDayEntries.mockClear();
    const result = await service.ingest(DATE, false, entries);
    expect(eminiplayer.findDayEntries).not.toHaveBeenCalled();
    expect(result.date).toBe(DATE);
    expect(result.recapDate).toBe(RECAP_DATE);
    expect(manifest.commit).toHaveBeenCalledTimes(1);
  });
```

(If the builder's `findDayEntries` mock is a plain `jest.fn(() => Promise.resolve(ENTRIES))` without a named implementation, replace the first two lines with the literal `DayEntries` object the mock returns — copy it from the builder.)

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer-ingest.service.spec -t resolvedEntries`
Expected: FAIL — `findDayEntries` WAS called (seam doesn't exist yet).

- [ ] **Step 3: Implement** — in `eminiplayer-ingest.service.ts`:

Change the `ingest` signature and pass-through:

```ts
  async ingest(date: string, force = false, resolvedEntries?: DayEntries): Promise<IngestResult> {
    const existing = this.inflight.get(date);
    if (existing) {
      // Coalesce same-flag calls (and non-force onto anything). A force call
      // finding a NON-force run must not be silently dropped: wait the
      // in-flight run out, then run the forced regeneration.
      if (!force || existing.force) return existing.run;
      await existing.run.catch(() => undefined);
      return this.ingest(date, true);
    }
    const run = this.run(date, force, resolvedEntries).finally(() => this.inflight.delete(date));
    this.inflight.set(date, { force, run });
    return run;
  }
```

Change `run`'s signature and its resolve stage:

```ts
  private async run(date: string, force: boolean, resolvedEntries?: DayEntries): Promise<IngestResult> {
    // Resolution always runs unless the caller (bulk backfill) already derived
    // the entries from its own single listing scrape — the recap filename
    // embeds the recap date, which only the archive listing knows.
    const entries =
      resolvedEntries ??
      (await this.stage('resolve', 'archive', () => this.eminiplayer.findDayEntries(date)));
```

(The rest of `run` already uses the local `entries` — no other change.)

- [ ] **Step 4: Run and watch it pass, plus the whole module**

Run: `pnpm exec jest eminiplayer`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/eminiplayer-ingest.service.ts src/eminiplayer/eminiplayer-ingest.service.spec.ts
git commit -m "feat(eminiplayer): accept pre-resolved day entries in ingest"
```

---

### Task 4: Config key `eminiplayer.backfillDelayMs`

**Files:**
- Modify: `backend/src/config/configuration.ts` (the `eminiplayer` interface block ~line 35 and the factory block ~line 110)
- Modify: `backend/src/config/configuration.spec.ts` (the `configuration (eminiplayer)` describe)
- Modify: `backend/.env.example` (after `EMINIPLAYER_VERIFY_MODEL`)

**Interfaces:**
- Produces: `config.get<number>('eminiplayer.backfillDelayMs')` — integer ms, default `2000`.

- [ ] **Step 1: Write the failing tests** — in `configuration.spec.ts`:
  - In the `beforeEach`, add `delete process.env.EMINIPLAYER_BACKFILL_DELAY_MS;`
  - In the defaults test, add `expect(cfg.eminiplayer.backfillDelayMs).toBe(2000);`
  - In the env-overrides test, set `process.env.EMINIPLAYER_BACKFILL_DELAY_MS = '500';` and add `backfillDelayMs: 500,` to the `toEqual` object (this `toEqual` is exhaustive — it WILL fail until the field exists).
  - New test:

```ts
  it('treats a set-but-empty EMINIPLAYER_BACKFILL_DELAY_MS as the 2000ms default', () => {
    process.env.EMINIPLAYER_BACKFILL_DELAY_MS = '';
    expect(configuration().eminiplayer.backfillDelayMs).toBe(2000);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest configuration.spec`
Expected: FAIL — `backfillDelayMs` undefined.

- [ ] **Step 3: Implement** — in `configuration.ts`, add to the `eminiplayer` interface:

```ts
    backfillDelayMs: number;
```

and to the factory's `eminiplayer` object (after `verifyModel`):

```ts
    // Pause between backfill days that touched the network — politeness knob
    // for eminiplayer.net and YouTube during multi-hour bulk runs. `||`, not
    // `??`: a copied .env.example sets this to '' and parseInt('') is NaN.
    backfillDelayMs: parseInt(process.env.EMINIPLAYER_BACKFILL_DELAY_MS || '2000', 10),
```

In `.env.example`, after the `EMINIPLAYER_VERIFY_MODEL` block:

```
# Pause (ms) between bulk-backfill days that touched the network. Default 2000.
EMINIPLAYER_BACKFILL_DELAY_MS=
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm exec jest configuration.spec`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/config/configuration.ts src/config/configuration.spec.ts .env.example
git commit -m "feat(config): eminiplayer.backfillDelayMs pacing knob"
```

---

### Task 5: `EminiplayerBackfillService` — job core

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-backfill.service.ts`
- Create: `backend/src/eminiplayer/eminiplayer-backfill.service.spec.ts`

**Interfaces:**
- Consumes: `EminiplayerService.fetchArchiveRows()` (Task 2), `EminiplayerIngestService.ingest(date, force, resolvedEntries)` (Task 3), `listTradePlanDates` + `selectDayEntries` (Task 1 / existing), `config.get('eminiplayer.backfillDelayMs')` (Task 4).
- Produces: `EminiplayerBackfillService.start(from, to): BackfillJobSnapshot`, `.status(): BackfillJobSnapshot | null`, `.cancel(): BackfillJobSnapshot | null`, `BackfillAlreadyRunningError`, and the exported snapshot types. Tests may await the private `loopPromise` field to synchronize.

- [ ] **Step 1: Write the failing tests** — create `eminiplayer-backfill.service.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import {
  BackfillAlreadyRunningError,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
import { RawArchiveRow } from './eminiplayer-archive';
import { IngestResult } from './eminiplayer-ingest.service';

const row = (dateText: string, href: string, title: string): RawArchiveRow => ({
  dateText,
  href,
  title,
});

// Three complete modern-era days (TP + prior recap each) — mirrors the
// captured listing. 08/11–08/13 2026 are Tue–Thu.
const ROWS: RawArchiveRow[] = [
  row('2026-08-13', '/post/r13.aspx', 'ES Recap (Video Lesson) for Thursday 08/13/2026'),
  row('2026-08-13', '/post/t13.aspx', 'ES Key Zones and Trade Plan for Thursday 08/13/2026'),
  row('2026-08-12', '/post/r12.aspx', 'ES Recap (Video Lesson) for Wed. 08/12/2026'),
  row('2026-08-12', '/post/t12.aspx', 'ES Key Zones and Trade Plan for Wed. 08/12/2026'),
  row('2026-08-11', '/post/r11.aspx', 'ES Recap (Video Lesson) for Tuesday 08/11/2026'),
  row('2026-08-11', '/post/t11.aspx', 'ES Key Zones and Trade Plan for Tuesday 08/11/2026'),
  row('2026-08-10', '/post/r10.aspx', 'ES Recap (Video Lesson) for Monday 08/10/2026'),
];

function result(date: string, status: 'uploaded' | 'skipped'): IngestResult {
  return {
    date,
    recapDate: 'irrelevant',
    staleRecapsRemoved: [],
    manifestPath: `knowledge-base/es/${date}/manifest.json`,
    files: {
      recap: { storagePath: 'r', status },
      tradePlanMd: { storagePath: 'm', status },
      tradePlanPdf: { storagePath: 'p', status },
    },
  };
}

function build(overrides: { ingest?: jest.Mock; rows?: RawArchiveRow[] } = {}) {
  const eminiplayer = {
    fetchArchiveRows: jest.fn(() => Promise.resolve(overrides.rows ?? ROWS)),
  };
  const ingest = {
    ingest:
      overrides.ingest ??
      jest.fn((date: string) => Promise.resolve(result(date, 'uploaded'))),
  };
  const config = {
    get: jest.fn((key: string) => (key === 'eminiplayer.backfillDelayMs' ? 5 : undefined)),
  } as unknown as ConfigService;
  const service = new EminiplayerBackfillService(
    eminiplayer as never,
    ingest as never,
    config,
  );
  // never actually wait in unit tests
  const sleep = jest
    .spyOn(service as never as { sleep: (ms: number) => Promise<void> }, 'sleep')
    .mockResolvedValue(undefined);
  return { service, eminiplayer, ingest, sleep };
}

/** Await the detached loop. */
const settle = (service: EminiplayerBackfillService) =>
  (service as never as { loopPromise: Promise<void> }).loopPromise;

describe('EminiplayerBackfillService — core', () => {
  it('status() is null before any job has run', () => {
    const { service } = build();
    expect(service.status()).toBeNull();
  });

  it('runs every candidate oldest-first with pre-resolved entries and finishes done', async () => {
    const { service, eminiplayer, ingest, sleep } = build();
    const snapshot = service.start('08112026', '08132026');
    expect(snapshot.state).toBe('running');
    await settle(service);

    expect(eminiplayer.fetchArchiveRows).toHaveBeenCalledTimes(1); // ONE scrape
    expect(ingest.ingest.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      '08112026',
      '08122026',
      '08132026',
    ]);
    // every call carries force=false and pre-resolved entries for that day
    for (const call of ingest.ingest.mock.calls) {
      expect(call[1]).toBe(false);
      expect(call[2].tradePlan.date).toBe(call[0]);
    }
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.finishedAt).not.toBeNull();
    expect(job.currentDate).toBeNull();
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 3, skipped: 0, failed: 0 });
    expect(sleep).toHaveBeenCalledTimes(3); // delay after each network day
    expect(sleep).toHaveBeenCalledWith(5); // the configured delay
  });

  it('counts an all-skipped day as skipped and does NOT sleep after it', async () => {
    const ingestMock = jest.fn((date: string) =>
      Promise.resolve(result(date, date === '08122026' ? 'skipped' : 'uploaded')),
    );
    const { service, sleep } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 2, skipped: 1, failed: 0 });
    expect(sleep).toHaveBeenCalledTimes(2); // no delay after the manifest-skip
  });

  it('rejects a second start while running, then allows one after completion', async () => {
    let release!: (r: IngestResult) => void;
    const gated = new Promise<IngestResult>((r) => (release = r));
    const ingestMock = jest.fn((date: string) =>
      date === '08112026' ? gated : Promise.resolve(result(date, 'uploaded')),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    expect(() => service.start('08112026', '08132026')).toThrow(BackfillAlreadyRunningError);
    release(result('08112026', 'uploaded'));
    await settle(service);
    expect(service.status()!.state).toBe('done');
    expect(() => service.start('08112026', '08132026')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer-backfill`
Expected: FAIL — module `./eminiplayer-backfill.service` does not exist.

- [ ] **Step 3: Implement** — create `eminiplayer-backfill.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EminiplayerService } from './eminiplayer.service';
import { EminiplayerIngestService, IngestResult } from './eminiplayer-ingest.service';
import { listTradePlanDates, selectDayEntries, RawArchiveRow } from './eminiplayer-archive';
import { ARCHIVE_URL, ArchiveNotFoundError } from './eminiplayer.constants';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';

export type BackfillState = 'running' | 'done' | 'cancelled' | 'failed';
export type BackfillFailureKind = 'notFound' | 'validation' | 'stage' | 'unknown';

export interface BackfillFailure {
  date: string;
  kind: BackfillFailureKind;
  message: string;
}

export interface BackfillJobSnapshot {
  state: BackfillState;
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  /** Day in flight; null when not running. */
  currentDate: string | null;
  counts: {
    /** TP dates found in range; null until the listing is scraped. */
    candidates: number | null;
    processed: number;
    uploaded: number;
    skipped: number;
    failed: number;
  };
  failures: BackfillFailure[];
  /** Job-level failure only (listing scrape / login) — per-day errors go to `failures`. */
  error: string | null;
}

/** Thrown by start() when a job is already running; controller maps to 409. */
export class BackfillAlreadyRunningError extends Error {
  constructor() {
    super('a backfill job is already running');
  }
}

/**
 * In-memory singleton bulk-backfill job (see the 2026-08-14 design spec).
 * Durable state lives in the per-day manifests, not here: a process death
 * costs one re-POST, and committed days short-circuit in ~0.2s with no site
 * traffic. Scrapes the archive listing ONCE per job and derives every day's
 * entries from that capture; one bad day lands in the ledger and never stops
 * the run.
 */
@Injectable()
export class EminiplayerBackfillService {
  private readonly logger = new Logger(EminiplayerBackfillService.name);
  private job: BackfillJobSnapshot | null = null;
  private cancelRequested = false;
  /** Test seam: the detached loop, awaitable. */
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly eminiplayer: EminiplayerService,
    private readonly ingestService: EminiplayerIngestService,
    private readonly config: ConfigService,
  ) {}

  /** Kick off a job; the returned snapshot is LIVE (it mutates as the loop runs). */
  start(from: string, to: string): BackfillJobSnapshot {
    if (this.job?.state === 'running') throw new BackfillAlreadyRunningError();
    this.cancelRequested = false;
    this.job = {
      state: 'running',
      from,
      to,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentDate: null,
      counts: { candidates: null, processed: 0, uploaded: 0, skipped: 0, failed: 0 },
      failures: [],
      error: null,
    };
    this.loopPromise = this.runLoop(this.job);
    return this.job;
  }

  /** Current (or most recently finished) job; null before the first start. */
  status(): BackfillJobSnapshot | null {
    return this.job;
  }

  /**
   * Request cancellation: the in-flight day finishes (a day is atomic — its
   * manifest either commits or doesn't), no further days start. No-op on a
   * finished job; null when no job has ever run.
   */
  cancel(): BackfillJobSnapshot | null {
    if (!this.job) return null;
    if (this.job.state === 'running') this.cancelRequested = true;
    return this.job;
  }

  private async runLoop(job: BackfillJobSnapshot): Promise<void> {
    try {
      const rows = await this.eminiplayer.fetchArchiveRows();
      const dates = listTradePlanDates(rows, job.from, job.to);
      job.counts.candidates = dates.length;
      this.logger.log(`backfill ${job.from}..${job.to}: ${dates.length} candidate days`);
      for (const date of dates) {
        if (this.cancelRequested) {
          job.state = 'cancelled';
          break;
        }
        job.currentDate = date;
        const touchedNetwork = await this.runDay(job, rows, date);
        job.counts.processed += 1;
        job.currentDate = null;
        if (touchedNetwork) await this.sleep(this.delayMs());
      }
      if (job.state === 'running') job.state = 'done';
    } catch (err) {
      // Job-level failure (listing scrape, login) — per-day errors never land here.
      job.state = 'failed';
      job.error = (err as Error).message;
      this.logger.error(`backfill failed: ${(err as Error).message}`);
    } finally {
      job.currentDate = null;
      job.finishedAt = new Date().toISOString();
      this.logger.log(
        `backfill ${job.state}: ${job.counts.uploaded} uploaded, ${job.counts.skipped} skipped, ${job.counts.failed} failed`,
      );
    }
  }

  /** Returns whether the day touched the network (drives the politeness delay). */
  private async runDay(
    job: BackfillJobSnapshot,
    rows: RawArchiveRow[],
    date: string,
  ): Promise<boolean> {
    try {
      const entries = selectDayEntries(rows, date, ARCHIVE_URL);
      const result = await this.ingestService.ingest(date, false, entries);
      if (this.allSkipped(result)) {
        job.counts.skipped += 1;
        return false; // served entirely from the manifest — no site traffic
      }
      job.counts.uploaded += 1;
      return true;
    } catch (err) {
      job.counts.failed += 1;
      job.failures.push({
        date,
        kind: this.classify(err),
        message: (err as Error).message,
      });
      this.logger.warn(`backfill day ${date} failed: ${(err as Error).message}`);
      return true;
    }
  }

  private allSkipped(result: IngestResult): boolean {
    return Object.values(result.files).every((f) => f.status === 'skipped');
  }

  private classify(err: unknown): BackfillFailureKind {
    if (err instanceof ArchiveNotFoundError) return 'notFound';
    if (err instanceof IngestValidationError) return 'validation';
    if (err instanceof IngestStageError) return 'stage';
    return 'unknown';
  }

  private delayMs(): number {
    return this.config.get<number>('eminiplayer.backfillDelayMs') ?? 2000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm exec jest eminiplayer-backfill`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/eminiplayer-backfill.service.ts src/eminiplayer/eminiplayer-backfill.service.spec.ts
git commit -m "feat(eminiplayer): bulk backfill job service (core loop)"
```

---

### Task 6: Backfill resilience — ledger, cancel, job-level failure

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-backfill.service.spec.ts` (append a describe; the implementation from Task 5 already contains the code under test — these tests PIN it and must pass without production changes; if one fails, fix the service, not the test)

- [ ] **Step 1: Write the tests** — append:

```ts
describe('EminiplayerBackfillService — resilience', () => {
  it('records a per-day failure with its kind and continues with later days', async () => {
    const ingestMock = jest.fn((date: string) =>
      date === '08122026'
        ? Promise.reject(new IngestValidationError('title gate said no'))
        : Promise.resolve(result(date, 'uploaded')),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('done'); // one bad day never fails the job
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 2, skipped: 0, failed: 1 });
    expect(job.failures).toEqual([
      { date: '08122026', kind: 'validation', message: 'title gate said no' },
    ]);
    expect(ingestMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [new IngestStageError('transcribe', 'recap', new Error('youtube 429')), 'stage'],
    [new ArchiveNotFoundError('gone'), 'notFound'],
    [new TypeError('bug'), 'unknown'],
  ])('classifies %p as %s', async (error, kind) => {
    const ingestMock = jest.fn((date: string) =>
      date === '08112026' ? Promise.reject(error) : Promise.resolve(result(date, 'uploaded')),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    expect(service.status()!.failures[0].kind).toBe(kind);
  });

  it('a day whose recap is missing from the listing lands in the ledger without calling ingest', async () => {
    // TP with no recap anywhere near it: 09/15/2026 is a Tuesday
    const rows = [
      ...ROWS,
      row('2026-09-15', '/post/lone.aspx', 'ES Key Zones and Trade Plan for Tuesday 09/15/2026'),
    ];
    const { service, ingest } = build({ rows });
    service.start('08112026', '09152026');
    await settle(service);
    const job = service.status()!;
    expect(job.counts.failed).toBe(1);
    expect(job.failures[0]).toMatchObject({ date: '09152026', kind: 'notFound' });
    expect(ingest.ingest.mock.calls.map((c: unknown[]) => c[0])).not.toContain('09152026');
  });

  it('cancel lets the in-flight day finish, starts no further days, ends cancelled', async () => {
    let release!: (r: IngestResult) => void;
    const gated = new Promise<IngestResult>((r) => (release = r));
    const ingestMock = jest.fn((date: string) =>
      date === '08112026' ? gated : Promise.resolve(result(date, 'uploaded')),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    service.cancel();
    release(result('08112026', 'uploaded'));
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('cancelled');
    expect(job.counts.processed).toBe(1); // the in-flight day finished and counted
    expect(ingestMock).toHaveBeenCalledTimes(1); // nothing after it started
    expect(job.finishedAt).not.toBeNull();
  });

  it('a listing-scrape failure fails the JOB with the error recorded', async () => {
    const { service, eminiplayer } = build();
    eminiplayer.fetchArchiveRows.mockRejectedValue(new Error('login failed'));
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toBe('login failed');
    expect(job.finishedAt).not.toBeNull();
  });

  it('cancel() is a no-op on a finished job and null before any job', async () => {
    const fresh = build();
    expect(fresh.service.cancel()).toBeNull();
    fresh.service.start('08112026', '08132026');
    await settle(fresh.service);
    const snap = fresh.service.cancel();
    expect(snap!.state).toBe('done'); // not flipped to cancelled
  });
});
```

Add the needed imports at the top of the spec: `IngestValidationError`, `IngestStageError` from `./eminiplayer-ingest.errors` and `ArchiveNotFoundError` from `./eminiplayer.constants`.

- [ ] **Step 2: Run**

Run: `pnpm exec jest eminiplayer-backfill`
Expected: all green (Task 5's implementation already covers these). Any failure here is a service bug — fix the service.

- [ ] **Step 3: Full module + suite check**

Run: `pnpm exec jest`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/eminiplayer/eminiplayer-backfill.service.spec.ts
git commit -m "test(eminiplayer): pin backfill ledger, cancel, and job-failure semantics"
```

---

### Task 7: Controller routes + module wiring

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer.controller.ts`
- Modify: `backend/src/eminiplayer/eminiplayer.module.ts`
- Test: `backend/src/eminiplayer/eminiplayer.controller.spec.ts`

**Interfaces:**
- Consumes: `EminiplayerBackfillService.start/status/cancel`, `BackfillAlreadyRunningError` (Task 5).
- Produces: `POST /eminiplayer/backfill?from=&to=` (202/400/409), `GET /eminiplayer/backfill` (200/404), `DELETE /eminiplayer/backfill` (200/404).

- [ ] **Step 1: Write the failing tests** — in `eminiplayer.controller.spec.ts`, extend `build()`:

```ts
async function build() {
  const ingest = { ingest: jest.fn((_date: string, _force: boolean) => Promise.resolve(RESULT)) };
  const audit = {
    audit: jest.fn(() =>
      Promise.resolve({ daysChecked: 0, ok: 0, deep: false, anomalies: [], uncommittedDays: [] }),
    ),
  };
  const JOB = {
    state: 'running',
    from: '08112026',
    to: '08132026',
    startedAt: '2026-08-14T00:00:00.000Z',
    finishedAt: null,
    currentDate: null,
    counts: { candidates: null, processed: 0, uploaded: 0, skipped: 0, failed: 0 },
    failures: [],
    error: null,
  };
  const backfill = {
    JOB,
    start: jest.fn(() => JOB),
    status: jest.fn(() => JOB),
    cancel: jest.fn(() => JOB),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [EminiplayerController],
    providers: [
      { provide: EminiplayerIngestService, useValue: ingest },
      { provide: EminiplayerAuditService, useValue: audit },
      { provide: EminiplayerBackfillService, useValue: backfill },
    ],
  }).compile();
  return { controller: moduleRef.get(EminiplayerController), ingest, audit, backfill };
}
```

(Import `EminiplayerBackfillService` and `BackfillAlreadyRunningError` from `./eminiplayer-backfill.service`, and `ConflictException` from `@nestjs/common`.)

Append a describe:

```ts
describe('/eminiplayer/backfill', () => {
  it('POST starts the job with the given range', async () => {
    const { controller, backfill } = await build();
    const out = await controller.startBackfill('01012018', '08132026');
    expect(backfill.start).toHaveBeenCalledWith('01012018', '08132026');
    expect(out).toBe(backfill.JOB);
  });

  it('POST defaults a missing "to" to today (MMDDYYYY)', async () => {
    const { controller, backfill } = await build();
    await controller.startBackfill('01012018', undefined);
    const to = backfill.start.mock.calls[0][1];
    expect(to).toMatch(/^\d{8}$/);
    const now = new Date();
    const expected = `${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate(),
    ).padStart(2, '0')}${now.getFullYear()}`;
    expect(to).toBe(expected);
  });

  it.each([
    [undefined, '08132026'],
    ['13012026', '08132026'], // not a real date
    ['01012018', '02302026'], // invalid "to"
  ])('POST rejects bad ranges (%s..%s) with 400', async (from, to) => {
    const { controller } = await build();
    await expect(controller.startBackfill(from as never, to)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('POST rejects a reversed range with 400', async () => {
    const { controller } = await build();
    await expect(controller.startBackfill('08132026', '08112026')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('POST maps an already-running job to 409', async () => {
    const { controller, backfill } = await build();
    backfill.start.mockImplementation(() => {
      throw new BackfillAlreadyRunningError();
    });
    await expect(controller.startBackfill('01012018', '08132026')).rejects.toThrow(
      ConflictException,
    );
  });

  it('GET returns the snapshot, or 404 when no job has run', async () => {
    const { controller, backfill } = await build();
    expect(controller.backfillStatus()).toBe(backfill.JOB);
    backfill.status.mockReturnValue(null);
    expect(() => controller.backfillStatus()).toThrow(NotFoundException);
  });

  it('DELETE cancels, or 404 when no job has run', async () => {
    const { controller, backfill } = await build();
    expect(controller.cancelBackfill()).toBe(backfill.JOB);
    expect(backfill.cancel).toHaveBeenCalled();
    backfill.cancel.mockReturnValue(null);
    expect(() => controller.cancelBackfill()).toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer.controller.spec`
Expected: FAIL — `startBackfill` does not exist.

- [ ] **Step 3: Implement** — in `eminiplayer.controller.ts`:

Add imports: `ConflictException`, `Delete` to the `@nestjs/common` import list; `parseMmddyyyy` from `./eminiplayer-validation`; and:

```ts
import {
  BackfillAlreadyRunningError,
  BackfillJobSnapshot,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
```

Add a module-level helper next to `isValidMmddyyyy`:

```ts
/** Today's local date as MMDDYYYY — the default upper bound for a backfill. */
function todayMmddyyyy(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}${dd}${now.getFullYear()}`;
}
```

Inject the service (add `private readonly backfillService: EminiplayerBackfillService,` to the constructor) and add the routes:

```ts
  @Post('backfill')
  @HttpCode(202) // job accepted; completion is observed via GET
  startBackfill(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): BackfillJobSnapshot {
    if (!from || !isValidMmddyyyy(from)) {
      throw new BadRequestException('Query param "from" (MMDDYYYY) is required');
    }
    const resolvedTo = to ?? todayMmddyyyy();
    if (!isValidMmddyyyy(resolvedTo)) {
      throw new BadRequestException('Query param "to" must be MMDDYYYY when present');
    }
    if (parseMmddyyyy(from).getTime() > parseMmddyyyy(resolvedTo).getTime()) {
      throw new BadRequestException('"from" must be on or before "to"');
    }
    try {
      return this.backfillService.start(from, resolvedTo);
    } catch (err) {
      if (err instanceof BackfillAlreadyRunningError) {
        throw new ConflictException({
          message: err.message,
          job: this.backfillService.status(),
        });
      }
      throw err;
    }
  }

  @Get('backfill')
  backfillStatus(): BackfillJobSnapshot {
    const job = this.backfillService.status();
    if (!job) throw new NotFoundException('no backfill job has run since boot');
    return job;
  }

  @Delete('backfill')
  cancelBackfill(): BackfillJobSnapshot {
    const job = this.backfillService.cancel();
    if (!job) throw new NotFoundException('no backfill job has run since boot');
    return job;
  }
```

In `eminiplayer.module.ts`, add `EminiplayerBackfillService` to BOTH `providers` and `exports` (the controller lives in `app.module`'s `controllers` and resolves its dependencies through this module's exports):

```ts
import { EminiplayerBackfillService } from './eminiplayer-backfill.service';
// providers: [..., EminiplayerBackfillService],
// exports: [EminiplayerService, EminiplayerIngestService, EminiplayerAuditService, EminiplayerBackfillService],
```

- [ ] **Step 4: Run controller spec, then the whole suite**

Run: `pnpm exec jest eminiplayer.controller.spec && pnpm exec jest`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/eminiplayer.controller.ts src/eminiplayer/eminiplayer.controller.spec.ts src/eminiplayer/eminiplayer.module.ts
git commit -m "feat(eminiplayer): POST/GET/DELETE /eminiplayer/backfill routes"
```

---

### Task 8: Build, live smoke week, wrap-up

**Files:** none (verification) — restart uses the compiled `dist/main`.

- [ ] **Step 1: Full suite + build**

Run: `pnpm exec jest && pnpm run build`
Expected: all suites green; `nest build` exits clean.

- [ ] **Step 2: Restart the backend on the fresh build** (SIGTERM has been observed to hang on this server — verify the PID actually changed, force-kill if needed)

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs -r kill -9; sleep 2
(nohup node --enable-source-maps dist/main > /tmp/backend-backfill.log 2>&1 &)
sleep 6 && curl -s http://localhost:3000/health/ready
```

Expected: `{"status":"ok","dependencies":{"firestore":"ok","storage":"ok"}}`

- [ ] **Step 3: Live smoke — one recent week** (08/07–08/13 2026 = 5 trading days; 08132026 is already committed, so expect 4 uploaded + 1 skipped)

```bash
curl -s -X POST "http://localhost:3000/eminiplayer/backfill?from=08072026&to=08132026" | python3 -m json.tool
# poll until state != running (~2–3 minutes):
watch -n 15 'curl -s http://localhost:3000/eminiplayer/backfill | python3 -m json.tool'
```

Expected final snapshot: `state: "done"`, `counts: {candidates: 5, processed: 5, uploaded: 4, skipped: 1, failed: 0}`, `failures: []`.

- [ ] **Step 4: Deep-audit the smoked range**

```bash
curl -s "http://localhost:3000/eminiplayer/audit?from=08072026&to=08132026&deep=true" | python3 -m json.tool
```

Expected: `daysChecked: 5, ok: 5, anomalies: []`.

- [ ] **Step 5: Verify GET-after-done and 409/cancel behavior live** (cheap, real HTTP)

```bash
curl -s http://localhost:3000/eminiplayer/backfill | python3 -m json.tool   # retained snapshot
curl -s -X DELETE http://localhost:3000/eminiplayer/backfill | python3 -m json.tool  # no-op 200 on finished job
```

- [ ] **Step 6: Commit any smoke-driven fixes** (if none, nothing to commit — Tasks 1–7 are already committed). The 2018 run itself is an operator action, not part of this plan:

```bash
# when ready:
curl -s -X POST "http://localhost:3000/eminiplayer/backfill?from=01012018" | python3 -m json.tool
```
