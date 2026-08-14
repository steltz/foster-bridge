# EminiPlayer Bulk Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-running in-process backfill job (`POST/GET/DELETE /eminiplayer/backfill`) that ingests every trade-plan day in a date range through the existing single-day pipeline, scraping the archive listing once per job.

**Architecture:** Four small seams on existing code (a pure `listTradePlanDates`, an extracted `EminiplayerService.fetchArchiveRows`, an optional `resolvedEntries` parameter + `fromManifest` flag on `EminiplayerIngestService`, a destroyed latch on `PlaywrightService`) plus one new `EminiplayerBackfillService` owning an in-memory singleton job with a per-day failure ledger, per-day timeout, frontier-freshness fallback, and shutdown participation — and three thin controller routes with an optional token guard. No persistence: per-day manifests already make re-POST resume free.

**Tech Stack:** NestJS 10, Jest (plain ts-jest — **spec files are type-checked**, so a type error in a test fails the whole suite file), Playwright (already wired), TypeScript strict. All commands run from `backend/`.

**Spec:** `docs/superpowers/specs/2026-08-14-eminiplayer-bulk-backfill-design.md` (revised after the adversarial review at `docs/superpowers/plans/2026-08-14-eminiplayer-bulk-backfill-review.md`)

## Global Constraints

- Semantic commit messages; **no Claude attribution lines** in commits (user rule).
- TDD every change: failing test first, watch it fail, minimal code, watch it pass. Because ts-jest type-checks specs, a test for a not-yet-existing symbol fails **at compile time** (TS2339/TS2554), not with a runtime assertion — that IS the expected red.
- Dates are `MMDDYYYY` strings everywhere in this module; listing row dates are ISO `YYYY-MM-DD`.
- Config keys and defaults exactly: `eminiplayer.backfillDelayMs` = 2000 (`EMINIPLAYER_BACKFILL_DELAY_MS`), `eminiplayer.backfillDayTimeoutMs` = 600000 (`EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS`), `eminiplayer.backfillToken` = unset (`EMINIPLAYER_BACKFILL_TOKEN`).
- Job snapshot field names exactly: `state/from/to/startedAt/finishedAt/currentDate/counts{candidates,processed,uploaded,skipped,failed}/failures[{date,kind,message}]/error`.
- Failure kinds exactly: `notFound | validation | stage | unknown`.
- Run tests with `pnpm exec jest <pattern>`; full suite must stay green after every task.

---

### Task 1: `listTradePlanDates` (pure candidate derivation)

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-archive.ts` (append at end of file)
- Test: `backend/src/eminiplayer/eminiplayer-archive.spec.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `RawArchiveRow`, `classifyArchiveTitle`, the module-private `rowDateToMmddyyyy`, `parseMmddyyyy` (already imported in this file).
- Produces: `listTradePlanDates(rows: RawArchiveRow[], from: string, to: string): string[]` — deduped trade-plan dates in `[from, to]` inclusive, ascending `MMDDYYYY[]`. Never throws on a bad row.

- [ ] **Step 1: Write the failing tests** — append to `eminiplayer-archive.spec.ts` (add `listTradePlanDates` to the existing `./eminiplayer-archive` import):

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

  it('skips a shape-valid but impossible calendar date instead of throwing', () => {
    // 2026-02-31 survives the shape regex but parseMmddyyyy would throw —
    // one garbage cell among 8,419 rows must cost nothing, not the whole job
    const withGarbage = [
      ...rows,
      row('2026-02-31', '/post/g.aspx', 'ES Key Zones and Trade Plan for Tuesday 02/31/2026'),
    ];
    expect(listTradePlanDates(withGarbage, '12292025', '01022026')).toEqual([
      '12292025',
      '12302025',
      '01022026',
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer-archive.spec -t listTradePlanDates`
Expected: FAIL to compile — `listTradePlanDates` is not exported (TS2305).

- [ ] **Step 3: Implement** — append to `eminiplayer-archive.ts`:

```ts
/**
 * All trade-plan dates in [from, to] (inclusive, MMDDYYYY), deduped and
 * ascending — the bulk backfill's candidate list, derived from ONE listing
 * scrape. Rows that fail classification, have malformed date cells, or carry
 * a shape-valid but impossible calendar date (2026-02-31) are skipped, never
 * fatal; per-day agreement checks run later, when each day is actually
 * processed.
 */
export function listTradePlanDates(rows: RawArchiveRow[], from: string, to: string): string[] {
  const fromT = parseMmddyyyy(from).getTime();
  const toT = parseMmddyyyy(to).getTime();
  const times = new Map<string, number>();
  for (const raw of rows) {
    const rowDate = rowDateToMmddyyyy(raw.dateText);
    if (!rowDate) continue;
    if (classifyArchiveTitle(raw.title)?.kind !== 'tradePlan') continue;
    let t: number;
    try {
      t = parseMmddyyyy(rowDate).getTime();
    } catch {
      continue; // shape-valid but impossible date — one bad row, zero cost
    }
    if (t < fromT || t > toT) continue;
    times.set(rowDate, t);
  }
  return [...times.entries()].sort((a, b) => a[1] - b[1]).map(([date]) => date);
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
Expected: FAIL to compile — TS2339, `fetchArchiveRows` does not exist on `EminiplayerService` (ts-jest type-checks; you will NOT see a runtime "is not a function").

- [ ] **Step 3: Implement** — in `eminiplayer.service.ts`, replace the body of `findDayEntries` and add the new method. Update the import line to include the type: `import { resolveEntryUrl, selectDayEntries, RawArchiveRow } from './eminiplayer-archive';`

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

- [ ] **Step 4: Run and watch everything pass** (the existing `findDayEntries` tests must stay green unmodified)

Run: `pnpm exec jest eminiplayer.service.spec`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/eminiplayer.service.ts src/eminiplayer/eminiplayer.service.spec.ts
git commit -m "refactor(eminiplayer): extract fetchArchiveRows from findDayEntries"
```

---

### Task 3: Ingest seam — `resolvedEntries` + `fromManifest`

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-ingest.service.ts` (the `IngestResult` interface, `ingest`, and `run` methods)
- Test: `backend/src/eminiplayer/eminiplayer-ingest.service.spec.ts`

**Interfaces:**
- Consumes: `DayEntries` from `./eminiplayer.constants` — **this file's constants import must be extended**: it currently imports only `ArchiveEntry, ArchiveNotFoundError, INGEST_PIPELINE_VERSION`; add `DayEntries`.
- Produces: `ingest(date: string, force?: boolean, resolvedEntries?: DayEntries): Promise<IngestResult>` — with entries provided, `eminiplayer.findDayEntries` is never called. `IngestResult` gains `fromManifest: boolean`, `true` only on the committed-manifest short-circuit.

- [ ] **Step 1: Write the failing tests** — append inside `describe('EminiplayerIngestService.ingest', …)`. The builder's `ENTRIES` constant (module level) is the exact object its `findDayEntries` mock resolves — use it directly:

```ts
  it('with resolvedEntries: skips archive resolution and feeds the entries into the pipeline', async () => {
    const { service, eminiplayer, manifest } = await build();
    const result = await service.ingest(DATE, false, ENTRIES);
    expect(eminiplayer.findDayEntries).not.toHaveBeenCalled();
    expect(result.date).toBe(DATE);
    expect(result.recapDate).toBe(RECAP_DATE);
    expect(result.fromManifest).toBe(false);
    expect(manifest.commit).toHaveBeenCalledTimes(1);
  });

  it('reports fromManifest: true exactly on the committed-day short-circuit', async () => {
    const { service } = await build({ committed: committedManifest() });
    const result = await service.ingest(DATE);
    expect(result.fromManifest).toBe(true);
    expect(result.files.recap.status).toBe('skipped');
  });
```

Then update the two existing assertions the new field breaks:
- In `'produces, verifies, uploads all three artifacts and commits a manifest'`, the top-level `expect(result).toEqual({ ... })` object gains `fromManifest: false,`.
- The existing short-circuit test (`'manifest short-circuit: committed day + matching recapDate …'`) needs no change unless it uses an exhaustive `toEqual` on the whole result — if it does, add `fromManifest: true`.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer-ingest.service.spec`
Expected: FAIL to compile — TS2554 (`ingest` takes 2 args, 3 passed) and TS2339 (`fromManifest` not on `IngestResult`).

- [ ] **Step 3: Implement** — in `eminiplayer-ingest.service.ts`:

Extend the constants import:

```ts
import {
  ArchiveEntry,
  ArchiveNotFoundError,
  DayEntries,
  INGEST_PIPELINE_VERSION,
} from './eminiplayer.constants';
```

Add the field to `IngestResult` (after `manifestPath`):

```ts
  /**
   * True only when a committed manifest answered the whole day (the
   * short-circuit) — the bulk backfill keys its skipped-count and its
   * politeness delay on this, NOT on per-file statuses, because a
   * fill-and-skip day (artifacts existed, manifest didn't) reports all files
   * 'skipped' while still doing page loads, re-verification, and a commit.
   */
  fromManifest: boolean;
```

Change the `ingest` signature — note the force-coalescing recursion passes `resolvedEntries` through:

```ts
  async ingest(date: string, force = false, resolvedEntries?: DayEntries): Promise<IngestResult> {
    const existing = this.inflight.get(date);
    if (existing) {
      // Coalesce same-flag calls (and non-force onto anything). A force call
      // finding a NON-force run must not be silently dropped: wait the
      // in-flight run out, then run the forced regeneration.
      if (!force || existing.force) return existing.run;
      await existing.run.catch(() => undefined);
      return this.ingest(date, true, resolvedEntries);
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
    // embeds the recap date, which only the archive listing knows. Contract on
    // resolvedEntries: derived from a scrape no older than RECAP_LOOKBACK_DAYS
    // before `date` (the backfill resolves frontier days fresh for this reason).
    const entries =
      resolvedEntries ??
      (await this.stage('resolve', 'archive', () => this.eminiplayer.findDayEntries(date)));
```

Set `fromManifest` on both return paths: in the committed-day short-circuit return object add `fromManifest: true,`; in the final (normal) return object add `fromManifest: false,`.

- [ ] **Step 4: Run the module suites** (the controller spec's `RESULT` fixture is structurally typed and keeps compiling; add `fromManifest: false,` to it anyway for accuracy)

Run: `pnpm exec jest eminiplayer`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/eminiplayer-ingest.service.ts src/eminiplayer/eminiplayer-ingest.service.spec.ts src/eminiplayer/eminiplayer.controller.spec.ts
git commit -m "feat(eminiplayer): resolvedEntries seam and fromManifest signal on ingest"
```

---

### Task 4: Config keys — delay, day timeout, token

**Files:**
- Modify: `backend/src/config/configuration.ts` (the `eminiplayer` interface block ~line 35 and the factory block ~line 110)
- Modify: `backend/src/config/configuration.spec.ts` (the `configuration (eminiplayer)` describe)
- Modify: `backend/.env.example` (after `EMINIPLAYER_VERIFY_MODEL`)

**Interfaces:**
- Produces: `config.get<number>('eminiplayer.backfillDelayMs')` (default 2000), `config.get<number>('eminiplayer.backfillDayTimeoutMs')` (default 600000), `config.get<string | undefined>('eminiplayer.backfillToken')` (default undefined).

- [ ] **Step 1: Write the failing tests** — in `configuration.spec.ts`:
  - In the `beforeEach`, add:
    ```ts
    delete process.env.EMINIPLAYER_BACKFILL_DELAY_MS;
    delete process.env.EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS;
    delete process.env.EMINIPLAYER_BACKFILL_TOKEN;
    ```
  - In the defaults test, add:
    ```ts
    expect(cfg.eminiplayer.backfillDelayMs).toBe(2000);
    expect(cfg.eminiplayer.backfillDayTimeoutMs).toBe(600000);
    expect(cfg.eminiplayer.backfillToken).toBeUndefined();
    ```
  - In the env-overrides test (its `toEqual` is exhaustive — it WILL fail until the fields exist), set:
    ```ts
    process.env.EMINIPLAYER_BACKFILL_DELAY_MS = '500';
    process.env.EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS = '30000';
    process.env.EMINIPLAYER_BACKFILL_TOKEN = 'hunter2';
    ```
    and add `backfillDelayMs: 500, backfillDayTimeoutMs: 30000, backfillToken: 'hunter2',` to the expected object.
  - New test:
    ```ts
    it('treats set-but-empty backfill values as their defaults (copied .env.example)', () => {
      process.env.EMINIPLAYER_BACKFILL_DELAY_MS = '';
      process.env.EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS = '';
      process.env.EMINIPLAYER_BACKFILL_TOKEN = '';
      const cfg = configuration();
      expect(cfg.eminiplayer.backfillDelayMs).toBe(2000);
      expect(cfg.eminiplayer.backfillDayTimeoutMs).toBe(600000);
      expect(cfg.eminiplayer.backfillToken).toBeUndefined();
    });
    ```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest configuration.spec`
Expected: FAIL — the three fields are undefined / missing from the exhaustive `toEqual`.

- [ ] **Step 3: Implement** — in `configuration.ts`, add to the `eminiplayer` interface:

```ts
    backfillDelayMs: number;
    backfillDayTimeoutMs: number;
    backfillToken?: string;
```

and to the factory's `eminiplayer` object (after `verifyModel`):

```ts
    // Pause between backfill days that touched the network — politeness knob
    // for eminiplayer.net and YouTube during multi-hour bulk runs. `||`, not
    // `??`: a copied .env.example sets this to '' and parseInt('') is NaN.
    backfillDelayMs: parseInt(process.env.EMINIPLAYER_BACKFILL_DELAY_MS || '2000', 10),
    // Per-day ceiling: a hung external call becomes a 'stage' ledger entry
    // instead of wedging the singleton job forever.
    backfillDayTimeoutMs: parseInt(
      process.env.EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS || '600000',
      10,
    ),
    // When set, POST/DELETE /eminiplayer/backfill require a matching
    // x-backfill-token header (`|| undefined` convention: empty = unset).
    backfillToken: process.env.EMINIPLAYER_BACKFILL_TOKEN || undefined,
```

In `.env.example`, after the `EMINIPLAYER_VERIFY_MODEL` block:

```
# Pause (ms) between bulk-backfill days that touched the network. Default 2000.
EMINIPLAYER_BACKFILL_DELAY_MS=
# Per-day ceiling (ms) for a bulk-backfill day; a timeout becomes a 'stage'
# ledger entry instead of wedging the job. Default 600000 (10 min).
EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS=
# Optional shared secret: when set, POST/DELETE /eminiplayer/backfill require
# a matching x-backfill-token header.
EMINIPLAYER_BACKFILL_TOKEN=
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm exec jest configuration.spec`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/config/configuration.ts src/config/configuration.spec.ts .env.example
git commit -m "feat(config): backfill pacing, day-timeout, and token knobs"
```

---

### Task 5: `PlaywrightService` destroyed latch

**Files:**
- Modify: `backend/src/eminiplayer/playwright.service.ts`
- Test: `backend/src/eminiplayer/playwright.service.spec.ts` (append)

**Interfaces:**
- Produces: after `onModuleDestroy()`, any `withPage()` call rejects with `eminiplayer: browser has been shut down` instead of relaunching Chromium (the dead-browser recovery path must not resurrect a browser mid-shutdown — that is the observed "SIGTERM hangs" bug).

- [ ] **Step 1: Write the failing test** — append inside the existing `describe('PlaywrightService', …)` (it provides `makeFakes()` and `build()`):

```ts
  it('after onModuleDestroy, withPage rejects instead of relaunching the browser', async () => {
    const { browser } = makeFakes();
    const service = await build();
    await service.withPage(async () => undefined); // launch once
    await service.onModuleDestroy();
    await expect(service.withPage(async () => undefined)).rejects.toThrow(
      /browser has been shut down/,
    );
    // the recovery path must NOT have relaunched
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest playwright.service.spec -t "after onModuleDestroy"`
Expected: FAIL — `withPage` resolves (the recovery path relaunched) and `chromium.launch` was called twice.

- [ ] **Step 3: Implement** — in `playwright.service.ts`:

Add a field next to the other private state:

```ts
  private destroyed = false;
```

At the top of `acquirePage()`:

```ts
    if (this.destroyed) {
      // Shutdown has run; the dead-browser recovery below must not resurrect
      // a fresh Chromium (it would keep the process from ever draining).
      throw new Error('eminiplayer: browser has been shut down');
    }
```

At the top of `onModuleDestroy()`:

```ts
    this.destroyed = true;
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm exec jest playwright.service.spec`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/eminiplayer/playwright.service.ts src/eminiplayer/playwright.service.spec.ts
git commit -m "fix(eminiplayer): playwright destroyed latch stops post-shutdown relaunch"
```

---

### Task 6: `EminiplayerBackfillService` — job core

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-backfill.service.ts`
- Create: `backend/src/eminiplayer/eminiplayer-backfill.service.spec.ts`

**Interfaces:**
- Consumes: `fetchArchiveRows()` (Task 2), `ingest(date, force, resolvedEntries?)` + `IngestResult.fromManifest` (Task 3), `listTradePlanDates`/`selectDayEntries`/`classifyArchiveTitle` (Task 1 / existing), config keys (Task 4), `RECAP_LOOKBACK_DAYS` + `ARCHIVE_URL` (constants).
- Produces: `EminiplayerBackfillService.start(from, to): BackfillJobSnapshot` (a copy), `.status(): BackfillJobSnapshot | null` (a copy), `.cancel(): BackfillJobSnapshot | null` (a copy), `BackfillAlreadyRunningError`, exported snapshot types. Test seams: private `loopPromise` (awaitable), protected-style private `sleep(ms)` and `now()` (spyable).

- [ ] **Step 1: Write the failing tests** — create `eminiplayer-backfill.service.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import {
  BackfillAlreadyRunningError,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
import { RawArchiveRow } from './eminiplayer-archive';
import { IngestResult } from './eminiplayer-ingest.service';
import { IngestValidationError } from './eminiplayer-ingest.errors';

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

function result(date: string, fromManifest = false): IngestResult {
  const status = fromManifest ? ('skipped' as const) : ('uploaded' as const);
  return {
    date,
    recapDate: 'irrelevant',
    staleRecapsRemoved: [],
    manifestPath: `knowledge-base/es/${date}/manifest.json`,
    fromManifest,
    files: {
      recap: { storagePath: 'r', status },
      tradePlanMd: { storagePath: 'm', status },
      tradePlanPdf: { storagePath: 'p', status },
    },
  };
}

// Default "now" is far past the fixture dates so no fixture day counts as
// frontier; the frontier test overrides it.
const FAR_FUTURE = new Date('2030-01-01T00:00:00Z').getTime();

function build(
  overrides: { ingest?: jest.Mock; rows?: RawArchiveRow[]; nowMs?: number; dayTimeoutMs?: number } = {},
) {
  const eminiplayer = {
    fetchArchiveRows: jest.fn(() => Promise.resolve(overrides.rows ?? ROWS)),
    findDayEntries: jest.fn((date: string) => Promise.reject(new Error(`unexpected fresh resolve for ${date}`))),
  };
  const ingest = {
    ingest: overrides.ingest ?? jest.fn((date: string) => Promise.resolve(result(date))),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'eminiplayer.backfillDelayMs') return 5;
      if (key === 'eminiplayer.backfillDayTimeoutMs') return overrides.dayTimeoutMs ?? 60_000;
      return undefined;
    }),
  } as unknown as ConfigService;
  const service = new EminiplayerBackfillService(
    eminiplayer as never,
    ingest as never,
    config,
  );
  const asSeams = service as never as {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    loopPromise: Promise<void>;
  };
  const sleep = jest.spyOn(asSeams, 'sleep').mockResolvedValue(undefined);
  jest.spyOn(asSeams, 'now').mockReturnValue(overrides.nowMs ?? FAR_FUTURE);
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

  it('start() validates the range itself (not just the controller)', () => {
    const { service } = build();
    expect(() => service.start('13012026', '08132026')).toThrow(IngestValidationError);
    expect(() => service.start('08132026', '08112026')).toThrow(/on or before/);
    expect(service.status()).toBeNull(); // nothing started
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
    // (nowMs is far-future, so nothing is frontier)
    for (const call of ingest.ingest.mock.calls) {
      expect(call[1]).toBe(false);
      expect((call[2] as { tradePlan: { date: string } }).tradePlan.date).toBe(call[0]);
    }
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.finishedAt).not.toBeNull();
    expect(job.currentDate).toBeNull();
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 3, skipped: 0, failed: 0 });
    expect(sleep).toHaveBeenCalledTimes(3); // delay after each network day
    expect(sleep).toHaveBeenCalledWith(5); // the configured delay
  });

  it('counts a fromManifest day as skipped and does NOT sleep after it', async () => {
    const ingestMock = jest.fn((date: string) =>
      Promise.resolve(result(date, date === '08122026')),
    );
    const { service, sleep } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 2, skipped: 1, failed: 0 });
    expect(sleep).toHaveBeenCalledTimes(2); // no delay after the manifest-skip
  });

  it('counts a fill-and-skip day (all files skipped but fromManifest false) as uploaded, with delay', async () => {
    const fillAndSkip = { ...result('08122026', true), fromManifest: false };
    const ingestMock = jest.fn((date: string) =>
      Promise.resolve(date === '08122026' ? fillAndSkip : result(date)),
    );
    const { service, sleep } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    expect(service.status()!.counts).toEqual({
      candidates: 3, processed: 3, uploaded: 3, skipped: 0, failed: 0,
    });
    expect(sleep).toHaveBeenCalledTimes(3); // fill-and-skip touched the network
  });

  it('snapshots returned from public methods are copies, not the live object', async () => {
    const { service } = build();
    const before = service.start('08112026', '08132026');
    await settle(service);
    expect(before.state).toBe('running'); // the copy did not mutate as the job ran
    const a = service.status()!;
    a.counts.processed = 999;
    expect(service.status()!.counts.processed).toBe(3); // internal state untouched
  });

  it('rejects a second start while running, then allows one after completion', async () => {
    let release!: (r: IngestResult) => void;
    const gated = new Promise<IngestResult>((r) => (release = r));
    const ingestMock = jest.fn((date: string) =>
      date === '08112026' ? gated : Promise.resolve(result(date)),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    expect(() => service.start('08112026', '08132026')).toThrow(BackfillAlreadyRunningError);
    release(result('08112026'));
    await settle(service);
    expect(service.status()!.state).toBe('done');
    expect(() => service.start('08112026', '08132026')).not.toThrow();
    await settle(service); // let the second job drain before the test ends
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer-backfill`
Expected: FAIL to compile — module `./eminiplayer-backfill.service` does not exist.

- [ ] **Step 3: Implement** — create `eminiplayer-backfill.service.ts`:

```ts
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EminiplayerService } from './eminiplayer.service';
import { EminiplayerIngestService, IngestResult } from './eminiplayer-ingest.service';
import {
  classifyArchiveTitle,
  listTradePlanDates,
  selectDayEntries,
  RawArchiveRow,
} from './eminiplayer-archive';
import { ARCHIVE_URL, ArchiveNotFoundError, RECAP_LOOKBACK_DAYS } from './eminiplayer.constants';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { parseMmddyyyy } from './eminiplayer-validation';

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
    /** Days the pipeline actually ran (produced or re-verified artifacts). */
    uploaded: number;
    /** Days served entirely from a committed manifest (result.fromManifest). */
    skipped: number;
    failed: number;
  };
  failures: BackfillFailure[];
  /** Job-level failure only (listing scrape / login / drift tripwire). */
  error: string | null;
}

/** Thrown by start() when a job is already running; controller maps to 409. */
export class BackfillAlreadyRunningError extends Error {
  constructor() {
    super('a backfill job is already running');
  }
}

/** Per-day ceiling exceeded — classified as a 'stage' (transient) failure. */
class BackfillDayTimeoutError extends Error {
  constructor(date: string, ms: number) {
    super(`day ${date} exceeded the ${ms}ms backfill day timeout`);
  }
}

/**
 * In-memory singleton bulk-backfill job (see the 2026-08-14 design spec).
 * Durable state lives in the per-day manifests, not here: a process death
 * costs one re-POST, and committed days short-circuit in ~0.2s with no site
 * traffic. Scrapes the archive listing ONCE per job and derives every day's
 * entries from that capture (frontier days re-resolve fresh); one bad day
 * lands in the ledger and never stops the run; every day races a timeout so
 * a hung socket can't wedge the singleton.
 */
@Injectable()
export class EminiplayerBackfillService implements OnApplicationShutdown {
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

  /** A 19-hour run WILL meet a SIGTERM: stop starting days so the loop drains. */
  onApplicationShutdown(): void {
    if (this.job?.state === 'running') {
      this.logger.log('shutdown: cancelling the running backfill job');
      this.cancelRequested = true;
    }
  }

  start(from: string, to: string): BackfillJobSnapshot {
    // Validate here too, not just in the controller — a future non-HTTP
    // caller with a reversed range must not silently get done/candidates:0.
    if (parseMmddyyyy(from).getTime() > parseMmddyyyy(to).getTime()) {
      throw new IngestValidationError('"from" must be on or before "to"');
    }
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
    return structuredClone(this.job);
  }

  /** Copy of the current (or most recently finished) job; null before the first start. */
  status(): BackfillJobSnapshot | null {
    return this.job ? structuredClone(this.job) : null;
  }

  /**
   * Request cancellation: the in-flight day finishes (a day is atomic — its
   * manifest either commits or doesn't), no further days start. No-op on a
   * finished job; null when no job has ever run.
   */
  cancel(): BackfillJobSnapshot | null {
    if (!this.job) return null;
    if (this.job.state === 'running') this.cancelRequested = true;
    return structuredClone(this.job);
  }

  private async runLoop(job: BackfillJobSnapshot): Promise<void> {
    try {
      const rows = await this.eminiplayer.fetchArchiveRows();
      // Drift tripwire: zero classifiable TP rows ANYWHERE means the listing
      // markup changed — a "done, candidates: 0" would misreport total scrape
      // failure as success. (An empty RANGE with a healthy archive is fine.)
      if (!rows.some((r) => classifyArchiveTitle(r.title)?.kind === 'tradePlan')) {
        throw new Error('listing scrape returned no classifiable trade-plan rows — selector drift?');
      }
      const dates = listTradePlanDates(rows, job.from, job.to);
      job.counts.candidates = dates.length;
      const scrapeTime = this.now();
      this.logger.log(`backfill ${job.from}..${job.to}: ${dates.length} candidate days`);
      for (const date of dates) {
        if (this.cancelRequested) {
          job.state = 'cancelled';
          break;
        }
        job.currentDate = date;
        const touchedNetwork = await this.runDay(job, rows, date, scrapeTime);
        job.counts.processed += 1;
        job.currentDate = null;
        if (touchedNetwork) await this.sleep(this.delayMs());
      }
      if (job.state === 'running') job.state = 'done';
    } catch (err) {
      // Job-level failure (listing scrape, login, drift tripwire) — per-day
      // errors never land here.
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
    scrapeTime: number,
  ): Promise<boolean> {
    let ingestInvoked = false;
    try {
      // Frontier days (within the recap lookback of the scrape moment) must
      // re-resolve fresh: a recap posted AFTER the scrape would otherwise be
      // invisible and the day would commit against an older in-window recap.
      const frontier =
        parseMmddyyyy(date).getTime() >= scrapeTime - RECAP_LOOKBACK_DAYS * 86_400_000;
      const entries = frontier ? undefined : selectDayEntries(rows, date, ARCHIVE_URL);
      ingestInvoked = true;
      const result = await this.withDayTimeout(
        this.ingestService.ingest(date, false, entries),
        date,
      );
      if (result.fromManifest) {
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
      // A pure selectDayEntries throw touched nothing — no delay owed.
      return ingestInvoked;
    }
  }

  private withDayTimeout(work: Promise<IngestResult>, date: string): Promise<IngestResult> {
    const ms = this.config.get<number>('eminiplayer.backfillDayTimeoutMs') ?? 600_000;
    return new Promise<IngestResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BackfillDayTimeoutError(date, ms)), ms);
      // The abandoned promise keeps running harmlessly: days are idempotent
      // and manifest-gated, so a late completion simply commits.
      work.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private classify(err: unknown): BackfillFailureKind {
    if (err instanceof BackfillDayTimeoutError) return 'stage'; // transient — re-POST retries
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

  /** Seam so tests can pin "frontier" deterministically. */
  private now(): number {
    return Date.now();
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

### Task 7: Backfill resilience — ledger, cancel, timeout, frontier, shutdown

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-backfill.service.spec.ts` (append a describe)

These tests pin behavior Task 6's implementation already contains. Standard TDD judgment applies: when one fails, first check whether the TEST's synchronization or fixtures are wrong, then the service — either may be the bug.

- [ ] **Step 1: Write the tests** — append (extend the spec's error imports with `IngestStageError` from `./eminiplayer-ingest.errors` and `ArchiveNotFoundError` from `./eminiplayer.constants`):

```ts
describe('EminiplayerBackfillService — resilience', () => {
  it('records a per-day failure with its kind and continues with later days', async () => {
    const ingestMock = jest.fn((date: string) =>
      date === '08122026'
        ? Promise.reject(new IngestValidationError('title gate said no'))
        : Promise.resolve(result(date)),
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
      date === '08112026' ? Promise.reject(error) : Promise.resolve(result(date)),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    expect(service.status()!.failures[0].kind).toBe(kind);
  });

  it('a day whose recap is missing from the listing lands in the ledger without calling ingest — and without sleeping', async () => {
    // TP with no recap anywhere near it: 09/15/2026 is a Tuesday
    const rows = [
      ...ROWS,
      row('2026-09-15', '/post/lone.aspx', 'ES Key Zones and Trade Plan for Tuesday 09/15/2026'),
    ];
    const { service, ingest, sleep } = build({ rows });
    service.start('08112026', '09152026');
    await settle(service);
    const job = service.status()!;
    expect(job.counts.failed).toBe(1);
    expect(job.failures[0]).toMatchObject({ date: '09152026', kind: 'notFound' });
    expect(ingest.ingest.mock.calls.map((c: unknown[]) => c[0])).not.toContain('09152026');
    expect(sleep).toHaveBeenCalledTimes(3); // only the 3 real days slept
  });

  it('a hung day hits the day timeout, is ledgered as stage, and the loop continues', async () => {
    const never = new Promise<IngestResult>(() => undefined); // hangs forever
    const ingestMock = jest.fn((date: string) =>
      date === '08122026' ? never : Promise.resolve(result(date)),
    );
    const { service } = build({ ingest: ingestMock, dayTimeoutMs: 20 });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.counts.failed).toBe(1);
    expect(job.failures[0]).toMatchObject({ date: '08122026', kind: 'stage' });
    expect(job.failures[0].message).toMatch(/day timeout/);
    expect(ingestMock).toHaveBeenCalledTimes(3); // later days still ran
  });

  it('frontier days (within the recap lookback of the scrape moment) resolve fresh — no pre-resolved entries', async () => {
    // "now" = the day after the newest fixture day, so all three are frontier
    const { service, ingest } = build({ nowMs: new Date('2026-08-14T12:00:00Z').getTime() });
    service.start('08112026', '08132026');
    await settle(service);
    expect(service.status()!.counts.uploaded).toBe(3);
    for (const call of ingest.ingest.mock.calls) {
      expect(call[2]).toBeUndefined(); // fresh resolve inside ingest instead
    }
  });

  it('cancel during a day lets it finish, starts no further days, ends cancelled', async () => {
    let release!: (r: IngestResult) => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const gated = new Promise<IngestResult>((r) => (release = r));
    const ingestMock = jest.fn((date: string) => {
      if (date === '08112026') {
        started();
        return gated;
      }
      return Promise.resolve(result(date));
    });
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await startedP; // day 1 is genuinely in flight before we cancel
    service.cancel();
    release(result('08112026'));
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('cancelled');
    expect(job.counts.processed).toBe(1); // the in-flight day finished and counted
    expect(ingestMock).toHaveBeenCalledTimes(1); // nothing after it started
    expect(job.finishedAt).not.toBeNull();
  });

  it('cancel before the first day starts cancels with zero days processed', async () => {
    const { service, ingest } = build();
    service.start('08112026', '08132026');
    service.cancel(); // lands while the loop is still awaiting the scrape
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('cancelled');
    expect(job.counts.processed).toBe(0);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('onApplicationShutdown cancels a running job like DELETE would', async () => {
    const { service, ingest } = build();
    service.start('08112026', '08132026');
    service.onApplicationShutdown();
    await settle(service);
    expect(service.status()!.state).toBe('cancelled');
    expect(ingest.ingest).not.toHaveBeenCalled();
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

  it('zero classifiable TP rows across the scrape trips the drift tripwire (failed, not done)', async () => {
    const { service } = build({ rows: [row('2026-08-13', '/post/r.aspx', 'Some Redesigned Title 08/13/2026')] });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/selector drift/);
  });

  it('an empty RANGE with a healthy archive completes done with candidates 0', async () => {
    const { service } = build();
    service.start('08152026', '08162026'); // Sat–Sun: no TP days
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.counts.candidates).toBe(0);
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

- [ ] **Step 2: Run**

Run: `pnpm exec jest eminiplayer-backfill`
Expected: all green against Task 6's implementation. Diagnose any failure on both sides (test synchronization vs service logic) before editing either.

- [ ] **Step 3: Full suite check**

Run: `pnpm exec jest`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/eminiplayer/eminiplayer-backfill.service.spec.ts
git commit -m "test(eminiplayer): pin backfill ledger, cancel, timeout, frontier, and shutdown semantics"
```

---

### Task 8: Controller routes, token guard, module wiring

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer.controller.ts`
- Modify: `backend/src/eminiplayer/eminiplayer.module.ts`
- Test: `backend/src/eminiplayer/eminiplayer.controller.spec.ts`

**Interfaces:**
- Consumes: `EminiplayerBackfillService.start/status/cancel`, `BackfillAlreadyRunningError` (Task 6), `config.get('eminiplayer.backfillToken')` (Task 4).
- Produces: `POST /eminiplayer/backfill?from=&to=` (202/400/401/409), `GET /eminiplayer/backfill` (200/404), `DELETE /eminiplayer/backfill` (200/401/404).

- [ ] **Step 1: Write the failing tests** — in `eminiplayer.controller.spec.ts`, extend `build()` to provide the backfill service and a config stub. **Mock typing note:** `jest.fn(() => JOB)` infers a zero-arg non-nullable mock — under ts-jest strict checking, `mock.calls[0][1]` and `mockReturnValue(null)` on it are hard compile errors. Type the mocks loosely as below.

```ts
async function build(cfg: Record<string, unknown> = {}) {
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
  // loosely typed on purpose: arg capture + mockReturnValue(null) must compile
  const backfill = {
    JOB,
    start: jest.fn() as jest.Mock,
    status: jest.fn() as jest.Mock,
    cancel: jest.fn() as jest.Mock,
  };
  backfill.start.mockReturnValue(JOB);
  backfill.status.mockReturnValue(JOB);
  backfill.cancel.mockReturnValue(JOB);
  const config = { get: jest.fn((key: string) => cfg[key]) };
  const moduleRef = await Test.createTestingModule({
    controllers: [EminiplayerController],
    providers: [
      { provide: EminiplayerIngestService, useValue: ingest },
      { provide: EminiplayerAuditService, useValue: audit },
      { provide: EminiplayerBackfillService, useValue: backfill },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return { controller: moduleRef.get(EminiplayerController), ingest, audit, backfill };
}
```

(Add imports: `ConflictException`, `UnauthorizedException` from `@nestjs/common`; `ConfigService` from `@nestjs/config`; `EminiplayerBackfillService`, `BackfillAlreadyRunningError` from `./eminiplayer-backfill.service`. Add `fromManifest: false,` to the `RESULT` fixture.)

Append a describe. **All POST/GET/DELETE handlers are synchronous** — use the sync `expect(() => ...).toThrow(...)` form throughout, never `.rejects`:

```ts
describe('/eminiplayer/backfill', () => {
  it('POST starts the job with the given range', async () => {
    const { controller, backfill } = await build();
    const out = controller.startBackfill('01012018', '08132026', undefined);
    expect(backfill.start).toHaveBeenCalledWith('01012018', '08132026');
    expect(out).toBe(backfill.JOB);
  });

  it('POST defaults a missing "to" to today in America/New_York (MMDDYYYY)', async () => {
    const { controller, backfill } = await build();
    controller.startBackfill('01012018', undefined, undefined);
    const to = backfill.start.mock.calls[0][1] as string;
    expect(to).toMatch(/^\d{8}$/);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    expect(to).toBe(`${get('month')}${get('day')}${get('year')}`);
  });

  it.each([
    [undefined, '08132026'],
    ['13012026', '08132026'], // not a real date
    ['01012018', '02302026'], // invalid "to"
  ])('POST rejects bad ranges (%s..%s) with 400', async (from, to) => {
    const { controller } = await build();
    expect(() => controller.startBackfill(from as string | undefined, to, undefined)).toThrow(
      BadRequestException,
    );
  });

  it('POST rejects a reversed range with 400', async () => {
    const { controller } = await build();
    expect(() => controller.startBackfill('08132026', '08112026', undefined)).toThrow(
      BadRequestException,
    );
  });

  it('POST maps an already-running job to 409', async () => {
    const { controller, backfill } = await build();
    backfill.start.mockImplementation(() => {
      throw new BackfillAlreadyRunningError();
    });
    expect(() => controller.startBackfill('01012018', '08132026', undefined)).toThrow(
      ConflictException,
    );
  });

  it('token guard: when configured, POST and DELETE require the matching header; GET stays open', async () => {
    const { controller, backfill } = await build({ 'eminiplayer.backfillToken': 's3cret' });
    expect(() => controller.startBackfill('01012018', '08132026', undefined)).toThrow(
      UnauthorizedException,
    );
    expect(() => controller.startBackfill('01012018', '08132026', 'wrong')).toThrow(
      UnauthorizedException,
    );
    expect(() => controller.cancelBackfill(undefined)).toThrow(UnauthorizedException);
    expect(controller.startBackfill('01012018', '08132026', 's3cret')).toBe(backfill.JOB);
    expect(controller.backfillStatus()).toBe(backfill.JOB); // GET unguarded
  });

  it('GET returns the snapshot, or 404 when no job has run', async () => {
    const { controller, backfill } = await build();
    expect(controller.backfillStatus()).toBe(backfill.JOB);
    backfill.status.mockReturnValue(null);
    expect(() => controller.backfillStatus()).toThrow(NotFoundException);
  });

  it('DELETE cancels, or 404 when no job has run', async () => {
    const { controller, backfill } = await build();
    expect(controller.cancelBackfill(undefined)).toBe(backfill.JOB);
    expect(backfill.cancel).toHaveBeenCalled();
    backfill.cancel.mockReturnValue(null);
    expect(() => controller.cancelBackfill(undefined)).toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec jest eminiplayer.controller.spec`
Expected: FAIL to compile — `startBackfill` does not exist on the controller (TS2339).

- [ ] **Step 3: Implement** — in `eminiplayer.controller.ts`:

Extend the `@nestjs/common` import with `ConflictException`, `Delete`, `Headers`, `UnauthorizedException`; add `import { ConfigService } from '@nestjs/config';`, `import { parseMmddyyyy } from './eminiplayer-validation';`, and:

```ts
import {
  BackfillAlreadyRunningError,
  BackfillJobSnapshot,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
```

Add a module-level helper next to `isValidMmddyyyy`:

```ts
/**
 * Today as MMDDYYYY in America/New_York — the site's trading-date timezone.
 * (Server-local time on a host west of ET would compute yesterday around
 * midnight and silently exclude today's trade plan from the default range.)
 */
function todayMmddyyyy(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('month')}${get('day')}${get('year')}`;
}
```

Extend the constructor:

```ts
  constructor(
    private readonly ingestService: EminiplayerIngestService,
    private readonly auditService: EminiplayerAuditService,
    private readonly backfillService: EminiplayerBackfillService,
    private readonly config: ConfigService,
  ) {}
```

Add the routes and the guard:

```ts
  /** 401 unless the configured token (if any) matches. GET stays unguarded. */
  private assertBackfillToken(token: string | undefined): void {
    const required = this.config.get<string>('eminiplayer.backfillToken');
    if (required && token !== required) {
      throw new UnauthorizedException('x-backfill-token header required');
    }
  }

  @Post('backfill')
  @HttpCode(202) // job accepted; completion is observed via GET
  startBackfill(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Headers('x-backfill-token') token: string | undefined,
  ): BackfillJobSnapshot {
    this.assertBackfillToken(token);
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
  cancelBackfill(@Headers('x-backfill-token') token: string | undefined): BackfillJobSnapshot {
    this.assertBackfillToken(token);
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
git commit -m "feat(eminiplayer): POST/GET/DELETE /eminiplayer/backfill routes with token guard"
```

---

### Task 9: Build, live smoke week, wrap-up

**Files:** none (verification) — restart uses the compiled `dist/main`.

- [ ] **Step 1: Full suite + build**

Run: `pnpm exec jest && pnpm run build`
Expected: all suites green; `nest build` exits clean.

- [ ] **Step 2: Restart the backend on the fresh build** (verify the PID actually changed; with the new shutdown latch SIGTERM should now drain, but force-kill remains the fallback)

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs -r kill; sleep 3
lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs -r kill -9; sleep 1
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

Expected final snapshot: `state: "done"`, `counts: {candidates: 5, processed: 5, uploaded: 4, skipped: 1, failed: 0}`, `failures: []`. (All five days are within `RECAP_LOOKBACK_DAYS` of now, so this smoke also exercises the frontier fresh-resolve path.)

- [ ] **Step 4: Deep-audit the smoked range**

```bash
curl -s "http://localhost:3000/eminiplayer/audit?from=08072026&to=08132026&deep=true" | python3 -m json.tool
```

Expected: `daysChecked: 5, ok: 5, anomalies: []`.

- [ ] **Step 5: Verify GET-after-done and cancel-no-op behavior live**

```bash
curl -s http://localhost:3000/eminiplayer/backfill | python3 -m json.tool   # retained snapshot
curl -s -X DELETE http://localhost:3000/eminiplayer/backfill | python3 -m json.tool  # no-op 200 on finished job
```

- [ ] **Step 6: Commit any smoke-driven fixes** (if none, nothing to commit — Tasks 1–8 are already committed). The 2018 run itself is an operator action, not part of this plan:

```bash
# when ready:
curl -s -X POST "http://localhost:3000/eminiplayer/backfill?from=01012018" | python3 -m json.tool
```
