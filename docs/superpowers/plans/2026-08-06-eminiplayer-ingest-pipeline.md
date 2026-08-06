# EminiPlayer Ingest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /eminiplayer/ingest?date=MMDDYYYY` scrapes eminiplayer.net for the day's Trade Plan (video + PDF) and the previous day's Recap video, transcribes both videos to markdown, and uploads all three documents to Firebase Storage under `knowledge-base/es/<date>/` — with scraper selector internals shipped as structured stubs.

**Architecture:** A new site-agnostic `TranscriptModule` (port of the root package's YouTube→markdown logic); three stubbed scraper contract methods on the existing `EminiplayerService`; a pure orchestrator `EminiplayerIngestService` (fill-and-skip idempotency, upload-as-you-go); a thin `EminiplayerController`. Spec: `docs/superpowers/specs/2026-08-06-eminiplayer-ingest-pipeline-design.md`.

**Tech Stack:** NestJS (CommonJS TS), `youtube-transcript@1.3.1`, `@google-cloud/storage` Bucket via the existing `STORAGE_BUCKET` provider, Playwright (existing `PlaywrightService`), jest.

## Global Constraints

- All work happens in `backend/` (its own package — run `pnpm` commands from `backend/`).
- Transcript markdown format must be byte-identical to the root `src/transcript.js` output: `# Transcript\n\n` header, `**MM:SS** text` lines (`H:MM:SS` from one hour up), trailing newline.
- Dates are `MMDDYYYY` strings everywhere (matches `knowledge-base/es/` folder names).
- Storage paths: `knowledge-base/es/<date>/<recapDate>_ES_RECAP.md`, `<date>_ES_TP.md`, `<date>_ES_TP.pdf`.
- Scraper extraction points throw `eminiplayer: <method> selectors not implemented yet` — no selector work in this plan.
- All `EminiplayerService` page access runs inside `this.playwright.withPage(...)`; never hold the page across calls.
- No live-site, live-YouTube, or live-bucket tests. Unit tests only, jest, collaborators mocked, `*.spec.ts` alongside sources.
- Semantic commit messages; no AI attributions in commits.
- Run tests with `pnpm test --testPathPattern=<pattern>` from `backend/`.

---

### Task 1: TranscriptService (YouTube → markdown port)

**Files:**
- Create: `backend/src/transcript/transcript.service.ts`
- Create: `backend/src/transcript/transcript.module.ts`
- Test: `backend/src/transcript/transcript.service.spec.ts`
- Modify: `backend/package.json` (add dependency)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `TranscriptModule` (exports `TranscriptService`); `TranscriptService.toMarkdown(urlOrId: string): Promise<string>`. Later tasks inject `TranscriptService` and import `TranscriptModule`.

- [ ] **Step 1: Install the dependency**

```bash
cd backend && pnpm add youtube-transcript@1.3.1
```

- [ ] **Step 2: Write the failing test**

`backend/src/transcript/transcript.service.spec.ts`:

```ts
jest.mock('youtube-transcript', () => ({
  YoutubeTranscript: { fetchTranscript: jest.fn() },
}));

import { YoutubeTranscript } from 'youtube-transcript';
import {
  TranscriptService,
  decodeEntities,
  formatOffset,
  transcriptToMarkdown,
} from './transcript.service';

const fetchTranscript = YoutubeTranscript.fetchTranscript as jest.Mock;

describe('formatOffset', () => {
  it('formats sub-hour offsets as MM:SS', () => {
    expect(formatOffset(0)).toBe('00:00');
    expect(formatOffset(59)).toBe('00:59');
    expect(formatOffset(65)).toBe('01:05');
    expect(formatOffset(600.9)).toBe('10:00'); // floors fractional seconds
  });

  it('formats one hour and up as H:MM:SS', () => {
    expect(formatOffset(3600)).toBe('1:00:00');
    expect(formatOffset(3725)).toBe('1:02:05');
  });
});

describe('decodeEntities', () => {
  it('decodes the entities YouTube captions contain', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(
      'a & b <c> "d" \'e\'',
    );
  });

  it('unwraps double-encoded forms (&amp; decoded first)', () => {
    expect(decodeEntities('it&amp;#39;s')).toBe("it's");
  });
});

describe('transcriptToMarkdown', () => {
  it('produces the knowledge-base transcript format byte-for-byte', () => {
    const segments = [
      { text: 'Right, good afternoon. Welcome to', offset: 0 },
      { text: "today's   live recap.", offset: 2.1 },
      { text: '   ', offset: 4 }, // whitespace-only: dropped
    ];
    expect(transcriptToMarkdown(segments)).toBe(
      '# Transcript\n\n' +
        '**00:00** Right, good afternoon. Welcome to\n' +
        "**00:02** today's live recap.\n",
    );
  });
});

describe('TranscriptService.toMarkdown', () => {
  beforeEach(() => fetchTranscript.mockReset());

  it('fetches, normalizes ms offsets to seconds, and formats', async () => {
    // youtube-transcript@1.3.1 returns offset/duration in MILLISECONDS
    fetchTranscript.mockResolvedValue([
      { text: 'hello', offset: 0, duration: 2000 },
      { text: 'world', offset: 61000, duration: 1500 },
    ]);
    const md = await new TranscriptService().toMarkdown('https://youtu.be/abc123');
    expect(fetchTranscript).toHaveBeenCalledWith('https://youtu.be/abc123');
    expect(md).toBe('# Transcript\n\n**00:00** hello\n**01:01** world\n');
  });

  it('wraps fetch failures with context', async () => {
    fetchTranscript.mockRejectedValue(new Error('boom'));
    await expect(new TranscriptService().toMarkdown('abc123')).rejects.toThrow(
      'transcript fetch failed for abc123: boom',
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && pnpm test --testPathPattern=transcript.service`
Expected: FAIL — cannot find module `./transcript.service`.

- [ ] **Step 4: Write the implementation**

`backend/src/transcript/transcript.service.ts` — a direct port of root `src/transcript.js` plus the ms→s normalization from root `src/transcript-command.js`:

```ts
import { Injectable } from '@nestjs/common';
import { YoutubeTranscript } from 'youtube-transcript';

// Decodes the entities YouTube captions actually contain. &amp; is decoded
// FIRST so double-encoded forms like &amp;#39; unwrap fully to an apostrophe.
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Seconds -> "MM:SS", or "H:MM:SS" from one hour up.
export function formatOffset(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface TranscriptSegment {
  text: string;
  offset: number; // seconds
}

export function transcriptToMarkdown(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const text = decodeEntities(String(seg.text ?? '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`**${formatOffset(seg.offset)}** ${text}`);
  }
  return `# Transcript\n\n${lines.join('\n')}\n`;
}

// youtube-transcript@1.3.1 returns offset/duration in MILLISECONDS for srv3
// captions (the common case; verified by live probe in the root package). Its
// classic-XML fallback path returns SECONDS, which this unconditional divide
// would compress 1000x — a known, accepted limitation shared with the root
// package's src/transcript-command.js, kept identical for byte-parity.
const OFFSET_DIVISOR = 1000;

/**
 * Site-agnostic YouTube -> transcript-markdown conversion. Output format is
 * byte-identical to the root package's `backtest transcript` CLI, which
 * produced the existing knowledge-base/es transcript files.
 */
@Injectable()
export class TranscriptService {
  async toMarkdown(urlOrId: string): Promise<string> {
    let raw: Array<{ text: string; offset: number }>;
    try {
      raw = await YoutubeTranscript.fetchTranscript(urlOrId);
    } catch (err) {
      throw new Error(
        `transcript fetch failed for ${urlOrId}: ${(err as Error).message}`,
      );
    }
    return transcriptToMarkdown(
      raw.map((seg) => ({ text: seg.text, offset: seg.offset / OFFSET_DIVISOR })),
    );
  }
}
```

`backend/src/transcript/transcript.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TranscriptService } from './transcript.service';

@Module({
  providers: [TranscriptService],
  exports: [TranscriptService],
})
export class TranscriptModule {}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && pnpm test --testPathPattern=transcript.service`
Expected: PASS (all describes).

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/transcript backend/package.json backend/pnpm-lock.yaml
git commit -m "feat(transcript): port YouTube transcript-to-markdown into backend TranscriptService"
```

---

### Task 2: EminiplayerService scraper contracts (stubbed)

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer.constants.ts` (add types)
- Modify: `backend/src/eminiplayer/eminiplayer.service.ts` (refactor + 3 new methods)
- Test: `backend/src/eminiplayer/eminiplayer.service.spec.ts` (extend)

**Interfaces:**
- Consumes: existing `PlaywrightService.withPage(fn)`, existing private login/goto helpers.
- Produces (used by Tasks 3–4):
  - `interface ArchiveEntry { date: string; pageUrl: string; title: string }` (`date` is `MMDDYYYY`) — in `eminiplayer.constants.ts`
  - `interface DayEntries { tradePlan: ArchiveEntry; recap: ArchiveEntry }` — in `eminiplayer.constants.ts`
  - `class ArchiveNotFoundError extends Error` and `const RECAP_LOOKBACK_DAYS = 14` — in `eminiplayer.constants.ts`. Not-found is the **scraper's** contract: once selectors land, `findDayEntries` throws `ArchiveNotFoundError` when the date has no TP entry or no recap within the lookback window; Task 3 passes it through untouched and Task 4 maps it to 404.
  - `EminiplayerService.findDayEntries(date: string): Promise<DayEntries>`
  - `EminiplayerService.getYoutubeUrl(pageUrl: string): Promise<string>`
  - `EminiplayerService.downloadTradePlanPdf(pageUrl: string): Promise<Buffer>`
  - All three run inside `withPage`, re-assert the landed URL after navigating (`assertOnArchivePage` / `assertOnPage`), and currently throw `Error('eminiplayer: <method> selectors not implemented yet')` at the extraction point.

- [ ] **Step 1: Reshape the `build` helper, then write the failing tests**

**1a — mandatory helper refactor.** The existing `build` in `backend/src/eminiplayer/eminiplayer.service.spec.ts` returns `moduleRef.get(EminiplayerService)` directly, and its `withPage` mock is created inline where nothing can inspect it. The new tests need both the service and the playwright mock, so change the helper to hoist the mock and return an object:

```ts
async function build(
  page: FakePage,
  config: Record<string, unknown> = {
    'eminiplayer.username': 'user@example.com',
    'eminiplayer.password': 'secret',
    'eminiplayer.screenshotDir': '/tmp/eminiplayer-shots',
  },
) {
  // pass-through mutex: run the callback immediately with the fake page
  const playwright = {
    withPage: jest.fn((fn: (p: FakePage) => Promise<unknown>) => fn(page)),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerService,
      { provide: PlaywrightService, useValue: playwright },
      {
        provide: ConfigService,
        useValue: { get: jest.fn((key: string) => config[key]) },
      },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerService), playwright };
}
```

Update **all existing call sites** in the file (currently 7) from `const service = await build(page)` to `const { service } = await build(page)`.

**1b — new tests.** Append to the same file. The detail-page tests override `url()` to the detail URL because the stubs re-assert the landed URL (a `makePage` default of `ARCHIVE_URL` would trip that assertion):

```ts
describe('scraper contract stubs', () => {
  it('findDayEntries navigates to the archive authenticated, then throws not-implemented', async () => {
    const page = makePage(); // default: logged in, url() === ARCHIVE_URL
    const { service } = await build(page);
    await expect(service.findDayEntries('07012026')).rejects.toThrow(
      'eminiplayer: findDayEntries selectors not implemented yet',
    );
    expect(page.goto).toHaveBeenCalledWith(ARCHIVE_URL, expect.anything());
  });

  it('findDayEntries logs in first when logged out', async () => {
    const page = makePage({
      // 1st check (archive): logged out; 2nd check (after login): logged in
      $: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValue(null),
    });
    const { service } = await build(page);
    await expect(service.findDayEntries('07012026')).rejects.toThrow(
      'selectors not implemented',
    );
    expect(page.fill).toHaveBeenCalledWith(SELECTORS.username, 'user@example.com');
    expect(page.click).toHaveBeenCalledWith(SELECTORS.submit);
  });

  it('getYoutubeUrl navigates to the detail page authenticated, then throws not-implemented', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/some-entry.aspx';
    const page = makePage({ url: jest.fn(() => detailUrl) });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(
      'eminiplayer: getYoutubeUrl selectors not implemented yet',
    );
    expect(page.goto).toHaveBeenCalledWith(detailUrl, expect.anything());
  });

  it('getYoutubeUrl throws a navigation error when the site redirects off the detail page', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/some-entry.aspx';
    // landed somewhere else (soft-404 / upsell / home) that is NOT logged-out
    const page = makePage({ url: jest.fn(() => 'https://www.eminiplayer.net/default.aspx') });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(
      'eminiplayer navigation failed',
    );
  });

  it('downloadTradePlanPdf navigates to the detail page authenticated, then throws not-implemented', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/tp-entry.aspx';
    const page = makePage({ url: jest.fn(() => detailUrl) });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toThrow(
      'eminiplayer: downloadTradePlanPdf selectors not implemented yet',
    );
    expect(page.goto).toHaveBeenCalledWith(detailUrl, expect.anything());
  });

  it('downloadTradePlanPdf throws a navigation error when the site redirects off the detail page', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/tp-entry.aspx';
    const page = makePage({ url: jest.fn(() => 'https://www.eminiplayer.net/default.aspx') });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toThrow(
      'eminiplayer navigation failed',
    );
  });

  it('each scraper method runs inside withPage (serialized page access)', async () => {
    const page = makePage();
    const { service, playwright } = await build(page);
    await service.findDayEntries('07012026').catch(() => undefined);
    await service.getYoutubeUrl('https://www.eminiplayer.net/x').catch(() => undefined);
    await service.downloadTradePlanPdf('https://www.eminiplayer.net/x').catch(() => undefined);
    expect((playwright.withPage as jest.Mock).mock.calls.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify the expected red state**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer.service`
Expected: the **whole `eminiplayer.service.spec.ts` file fails to compile** with TS2339 `Property 'findDayEntries' does not exist on type 'EminiplayerService'` (ts-jest type-checks the file, so the pre-existing tests in this file go red with it — that is the expected red state, not a runtime "is not a function").

- [ ] **Step 3: Add types to `eminiplayer.constants.ts`**

Append:

```ts
/** One row of the archive listing, date normalized to MMDDYYYY. */
export interface ArchiveEntry {
  date: string;
  pageUrl: string;
  title: string;
}

/**
 * The two archive entries an ingest run needs: the trade plan for the
 * requested date and the most recent recap dated strictly before it.
 */
export interface DayEntries {
  tradePlan: ArchiveEntry;
  recap: ArchiveEntry;
}

/**
 * The archive doesn't have what was asked for: no TP entry for the date, or
 * no recap entry within the recap search window before it (the recap scan is
 * bounded to RECAP_LOOKBACK_DAYS calendar days so a bad historical date can't
 * force a whole-archive walk inside one withPage callback). Owned by the
 * scraper layer — findDayEntries throws it once selectors land; the ingest
 * layer passes it through untouched and the controller maps it to HTTP 404.
 */
export class ArchiveNotFoundError extends Error {}

/** Bound for the backwards recap scan in findDayEntries. */
export const RECAP_LOOKBACK_DAYS = 14;
```

- [ ] **Step 4: Refactor + implement the stubs in `eminiplayer.service.ts`**

First extract the auth-aware navigation from `openArchivePage` into a private helper, so all four public methods share one login flow:

```ts
/**
 * Navigate to `url`, logging in (and re-navigating) when the site shows its
 * logged-out state. Shared by every public method; must be called inside a
 * withPage() callback.
 */
private async gotoAuthenticated(page: Page, url: string, step: string): Promise<void> {
  await this.goto(page, url, step);
  if (await this.isLoggedOut(page)) {
    this.logger.log('Not authenticated; logging in');
    await this.login(page);
    await this.goto(page, url, `re-${step} after login`);
    if (await this.isLoggedOut(page)) {
      throw new Error(
        'eminiplayer login failed: login link still present after signing in (check credentials)',
      );
    }
  }
}
```

Rewrite `openArchivePage` to use it (behavior unchanged — existing tests must keep passing; note the step string stays exactly `'navigating to archive.aspx'` so the re-goto message remains `'re-navigating to archive.aspx after login'`):

```ts
async openArchivePage(): Promise<ArchivePageResult> {
  return this.playwright.withPage(async (page) => {
    await this.gotoAuthenticated(page, ARCHIVE_URL, 'navigating to archive.aspx');
    this.assertOnArchivePage(page);
    const screenshotPath = await this.screenshot(page);
    return { url: page.url(), title: await page.title(), screenshotPath };
  });
}
```

Add a structural landed-URL assertion for detail pages, next to `assertOnArchivePage` (the module contract — see the class docstring — requires every method to re-assert its location rather than assume where the page was left; a WebForms auth bounce or soft-404 redirect must not reach an extraction point):

```ts
/**
 * Structural check that the page landed where we asked. Same rationale as
 * assertOnArchivePage: a redirect (login.aspx?ReturnUrl=..., soft-404, home
 * page) must fail loudly here, not surface later as a selector mismatch.
 */
private assertOnPage(page: Page, expectedUrl: string): void {
  const url = new URL(page.url());
  const expected = new URL(expectedUrl);
  const landed =
    url.hostname === expected.hostname &&
    url.pathname.toLowerCase() === expected.pathname.toLowerCase();
  if (!landed) {
    throw new Error(
      `eminiplayer navigation failed: expected ${expectedUrl}, landed on ${page.url()}`,
    );
  }
}
```

Then add the three contract methods (import `ArchiveEntry`, `DayEntries` from the constants file):

```ts
/**
 * Scan the archive listing for the trade-plan entry dated `date` (MMDDYYYY)
 * and the most recent recap entry dated strictly before it.
 */
async findDayEntries(date: string): Promise<DayEntries> {
  return this.playwright.withPage(async (page) => {
    await this.gotoAuthenticated(page, ARCHIVE_URL, 'navigating to archive.aspx');
    this.assertOnArchivePage(page);
    // TODO(selectors): parse the listing rows into ArchiveEntry[] and select
    // the TP entry for `date` + the latest recap before it. Contract for the
    // selector follow-up: throw ArchiveNotFoundError (eminiplayer.constants)
    // when there is no TP entry for `date`, or no recap entry dated within
    // RECAP_LOOKBACK_DAYS calendar days strictly before it — the controller
    // maps that to 404, and the bound keeps the scan from walking the whole
    // multi-year archive inside this withPage callback.
    throw new Error('eminiplayer: findDayEntries selectors not implemented yet');
  });
}

/** Extract the embedded YouTube URL from an archive detail page. */
async getYoutubeUrl(pageUrl: string): Promise<string> {
  return this.playwright.withPage(async (page) => {
    await this.gotoAuthenticated(page, pageUrl, `navigating to ${pageUrl}`);
    this.assertOnPage(page, pageUrl);
    // TODO(selectors): locate the embedded YouTube iframe/link on the page.
    throw new Error('eminiplayer: getYoutubeUrl selectors not implemented yet');
  });
}

/** Download the trade-plan PDF linked from a TP detail page. */
async downloadTradePlanPdf(pageUrl: string): Promise<Buffer> {
  return this.playwright.withPage(async (page) => {
    await this.gotoAuthenticated(page, pageUrl, `navigating to ${pageUrl}`);
    this.assertOnPage(page, pageUrl);
    // TODO(selectors): find the PDF link and capture the download as a Buffer.
    throw new Error('eminiplayer: downloadTradePlanPdf selectors not implemented yet');
  });
}
```

`date` is intentionally unused until the selector work lands; if the linter objects, prefix-name it `_date` in the signature — but keep the public parameter name meaningful in the type via the interface docs.

- [ ] **Step 5: Run the eminiplayer tests**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer`
Expected: PASS — all new stub tests and every pre-existing `openArchivePage` test (the refactor must not change messages or call order).

- [ ] **Step 6: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/eminiplayer
git commit -m "feat(eminiplayer): add stubbed scraper contracts for day entries, youtube url, and TP pdf"
```

---

### Task 3: EminiplayerIngestService (orchestrator)

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-ingest.errors.ts`
- Create: `backend/src/eminiplayer/eminiplayer-ingest.service.ts`
- Test: `backend/src/eminiplayer/eminiplayer-ingest.service.spec.ts`
- Modify: `backend/src/eminiplayer/eminiplayer.module.ts` (import TranscriptModule, provide + export ingest service)

**Interfaces:**
- Consumes:
  - `EminiplayerService.findDayEntries(date) → Promise<DayEntries>` / `.getYoutubeUrl(pageUrl) → Promise<string>` / `.downloadTradePlanPdf(pageUrl) → Promise<Buffer>` (Task 2)
  - `TranscriptService.toMarkdown(urlOrId) → Promise<string>` (Task 1)
  - `STORAGE_BUCKET` provider (`Bucket` from `@google-cloud/storage`): `bucket.file(path).exists() → Promise<[boolean]>`, `bucket.file(path).save(data, { contentType }) → Promise<void>`
- Produces (used by Task 4):
  - `class IngestStageError extends Error { readonly stage: string; readonly artifact: string }`
  - `interface IngestFileReport { storagePath: string; status: 'uploaded' | 'skipped' }`
  - `interface IngestResult { date: string; recapDate: string; staleRecapsRemoved: string[]; files: { recap: IngestFileReport; tradePlanMd: IngestFileReport; tradePlanPdf: IngestFileReport } }`
  - `EminiplayerIngestService.ingest(date: string, force?: boolean): Promise<IngestResult>` — concurrent calls for the same date coalesce onto the in-flight run's promise; `ArchiveNotFoundError` (Task 2) passes through untouched for Task 4 to map to 404.

- [ ] **Step 1: Write the errors file**

`backend/src/eminiplayer/eminiplayer-ingest.errors.ts` (the 404 not-found signal is NOT here — it's `ArchiveNotFoundError` in `eminiplayer.constants.ts`, owned by the scraper layer that is the only layer able to detect it; this file holds only the orchestrator's own error):

```ts
/**
 * A pipeline stage failed. Maps to HTTP 502. Stages: 'plan' (storage
 * existence checks / stale-recap cleanup), 'resolve' (scraping), 'transcribe'
 * (YouTube transcript fetch), 'download' (pdf), 'upload' (bucket save).
 * Already-uploaded artifacts remain in the bucket, so a retry resumes via
 * fill-and-skip. ArchiveNotFoundError deliberately does NOT get wrapped into
 * this — it passes through to the controller's 404 mapping.
 */
export class IngestStageError extends Error {
  constructor(
    readonly stage: 'plan' | 'resolve' | 'transcribe' | 'download' | 'upload',
    readonly artifact: 'archive' | 'recap' | 'tradePlanMd' | 'tradePlanPdf',
    cause: Error,
  ) {
    super(`eminiplayer ingest failed at ${stage} (${artifact}): ${cause.message}`);
  }
}
```

- [ ] **Step 2: Write the failing tests**

`backend/src/eminiplayer/eminiplayer-ingest.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import { EminiplayerService } from './eminiplayer.service';
import { TranscriptService } from '../transcript/transcript.service';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { IngestStageError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError, type DayEntries } from './eminiplayer.constants';

const DATE = '07012026';
const RECAP_DATE = '06302026';
const DIR = `knowledge-base/es/${DATE}`;
const RECAP_PATH = `${DIR}/${RECAP_DATE}_ES_RECAP.md`;
const TP_MD_PATH = `${DIR}/${DATE}_ES_TP.md`;
const TP_PDF_PATH = `${DIR}/${DATE}_ES_TP.pdf`;

const ENTRIES: DayEntries = {
  tradePlan: {
    date: DATE,
    pageUrl: 'https://www.eminiplayer.net/post/tp.aspx',
    title: 'ES Key Zones and Trade Plan',
  },
  recap: {
    date: RECAP_DATE,
    pageUrl: 'https://www.eminiplayer.net/post/recap.aspx',
    title: 'ES Recap/Video Lesson',
  },
};

type FakeFile = { name: string; exists: jest.Mock; save: jest.Mock; delete: jest.Mock };

function makeBucket(existing: Record<string, boolean> = {}) {
  const files = new Map<string, FakeFile>();
  const get = (path: string): FakeFile => {
    if (!files.has(path)) {
      files.set(path, {
        name: path,
        exists: jest.fn(() => Promise.resolve([existing[path] ?? false])),
        save: jest.fn(() => Promise.resolve()),
        delete: jest.fn(() => Promise.resolve()),
      });
    }
    return files.get(path)!;
  };
  return {
    files,
    file: jest.fn(get),
    // getFiles({ prefix }) lists the objects marked existing under that prefix
    getFiles: jest.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve([
        Object.keys(existing)
          .filter((p) => existing[p] && p.startsWith(prefix))
          .map(get),
      ]),
    ),
  };
}

async function build({
  bucket = makeBucket(),
  entries = ENTRIES,
}: { bucket?: ReturnType<typeof makeBucket>; entries?: DayEntries } = {}) {
  const eminiplayer = {
    findDayEntries: jest.fn(() => Promise.resolve(entries)),
    getYoutubeUrl: jest.fn((pageUrl: string) =>
      Promise.resolve(`https://youtu.be/${pageUrl.includes('recap') ? 'RECAP' : 'TP'}`),
    ),
    downloadTradePlanPdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-fake'))),
  };
  const transcript = {
    toMarkdown: jest.fn((url: string) => Promise.resolve(`# Transcript\n\n**00:00** ${url}\n`)),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerIngestService,
      { provide: EminiplayerService, useValue: eminiplayer },
      { provide: TranscriptService, useValue: transcript },
      { provide: STORAGE_BUCKET, useValue: bucket },
    ],
  }).compile();
  return {
    service: moduleRef.get(EminiplayerIngestService),
    eminiplayer,
    transcript,
    bucket,
  };
}

describe('EminiplayerIngestService.ingest', () => {
  it('produces and uploads all three artifacts on the happy path', async () => {
    const { service, bucket, transcript } = await build();
    const result = await service.ingest(DATE);

    expect(result).toEqual({
      date: DATE,
      recapDate: RECAP_DATE,
      staleRecapsRemoved: [],
      files: {
        recap: { storagePath: RECAP_PATH, status: 'uploaded' },
        tradePlanMd: { storagePath: TP_MD_PATH, status: 'uploaded' },
        tradePlanPdf: { storagePath: TP_PDF_PATH, status: 'uploaded' },
      },
    });

    expect(transcript.toMarkdown).toHaveBeenCalledWith('https://youtu.be/RECAP');
    expect(transcript.toMarkdown).toHaveBeenCalledWith('https://youtu.be/TP');

    expect(bucket.files.get(RECAP_PATH)!.save).toHaveBeenCalledWith(
      expect.stringContaining('# Transcript'),
      { contentType: 'text/markdown' },
    );
    expect(bucket.files.get(TP_MD_PATH)!.save).toHaveBeenCalledWith(
      expect.stringContaining('# Transcript'),
      { contentType: 'text/markdown' },
    );
    expect(bucket.files.get(TP_PDF_PATH)!.save).toHaveBeenCalledWith(
      expect.any(Buffer),
      { contentType: 'application/pdf' },
    );
  });

  it('skips artifacts that already exist (fill-and-skip)', async () => {
    const bucket = makeBucket({ [RECAP_PATH]: true, [TP_PDF_PATH]: true });
    const { service, eminiplayer, transcript } = await build({ bucket });
    const result = await service.ingest(DATE);

    expect(result.files.recap.status).toBe('skipped');
    expect(result.files.tradePlanMd.status).toBe('uploaded');
    expect(result.files.tradePlanPdf.status).toBe('skipped');
    // recap page never scraped or transcribed; TP transcript still produced
    expect(eminiplayer.getYoutubeUrl).toHaveBeenCalledTimes(1);
    expect(eminiplayer.getYoutubeUrl).toHaveBeenCalledWith(ENTRIES.tradePlan.pageUrl);
    expect(eminiplayer.downloadTradePlanPdf).not.toHaveBeenCalled();
    expect(transcript.toMarkdown).toHaveBeenCalledTimes(1);
  });

  it('force=true regenerates everything, skipping the existence checks', async () => {
    const bucket = makeBucket({ [RECAP_PATH]: true, [TP_MD_PATH]: true, [TP_PDF_PATH]: true });
    const { service } = await build({ bucket });
    const result = await service.ingest(DATE, true);

    expect(result.files.recap.status).toBe('uploaded');
    expect(result.files.tradePlanMd.status).toBe('uploaded');
    expect(result.files.tradePlanPdf.status).toBe('uploaded');
    expect(bucket.files.get(RECAP_PATH)!.exists).not.toHaveBeenCalled();
  });

  it('still resolves entries when everything is skipped (recap filename needs the recap date)', async () => {
    const bucket = makeBucket({ [RECAP_PATH]: true, [TP_MD_PATH]: true, [TP_PDF_PATH]: true });
    const { service, eminiplayer } = await build({ bucket });
    const result = await service.ingest(DATE);
    expect(eminiplayer.findDayEntries).toHaveBeenCalledWith(DATE);
    expect(result.files.recap.status).toBe('skipped');
    expect(result.files.tradePlanMd.status).toBe('skipped');
    expect(result.files.tradePlanPdf.status).toBe('skipped');
  });

  it('propagates ArchiveNotFoundError from findDayEntries untouched (404 path)', async () => {
    const { service, eminiplayer } = await build();
    eminiplayer.findDayEntries.mockRejectedValue(
      new ArchiveNotFoundError('no trade plan entry for 07012026'),
    );
    await expect(service.ingest(DATE)).rejects.toThrow(ArchiveNotFoundError);
  });

  it('removes stale recap files whose date no longer matches the resolved recap', async () => {
    // an earlier run (before the 06/30 recap was posted) uploaded 06/29's
    const stalePath = `${DIR}/06292026_ES_RECAP.md`;
    const bucket = makeBucket({ [stalePath]: true });
    const { service } = await build({ bucket });
    const result = await service.ingest(DATE);
    expect(result.staleRecapsRemoved).toEqual([stalePath]);
    expect(bucket.files.get(stalePath)!.delete).toHaveBeenCalled();
    expect(result.files.recap.status).toBe('uploaded'); // correct recap produced
  });

  it('does not treat the currently-resolved recap as stale', async () => {
    const bucket = makeBucket({ [RECAP_PATH]: true });
    const { service } = await build({ bucket });
    const result = await service.ingest(DATE);
    expect(result.staleRecapsRemoved).toEqual([]);
    expect(bucket.files.get(RECAP_PATH)!.delete).not.toHaveBeenCalled();
    expect(result.files.recap.status).toBe('skipped');
  });

  it('coalesces concurrent ingests for the same date onto one run', async () => {
    const { service, eminiplayer } = await build();
    const [a, b] = await Promise.all([service.ingest(DATE), service.ingest(DATE)]);
    expect(a).toBe(b);
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(1);
    // once the run settles, a new request runs fresh
    await service.ingest(DATE);
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(2);
  });

  it('wraps a resolve failure as IngestStageError(resolve, archive)', async () => {
    const { service, eminiplayer } = await build();
    eminiplayer.findDayEntries.mockRejectedValue(new Error('selectors not implemented yet'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.stage).toBe('resolve');
    expect(err.artifact).toBe('archive');
    expect(err.message).toContain('selectors not implemented yet');
  });

  it('a mid-run failure preserves earlier uploads (resume semantics)', async () => {
    const { service, eminiplayer, bucket } = await build();
    // recap succeeds; TP transcript scrape fails
    eminiplayer.getYoutubeUrl
      .mockImplementationOnce(() => Promise.resolve('https://youtu.be/RECAP'))
      .mockImplementationOnce(() => Promise.reject(new Error('tp page broke')));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.artifact).toBe('tradePlanMd');
    expect(bucket.files.get(RECAP_PATH)!.save).toHaveBeenCalled(); // recap already uploaded
    expect(bucket.files.get(TP_PDF_PATH)?.save).toBeUndefined(); // pdf never reached
  });

  it('wraps an upload failure as IngestStageError(upload, <artifact>)', async () => {
    const bucket = makeBucket();
    const { service } = await build({ bucket });
    bucket.file(RECAP_PATH); // pre-create so we can break save
    bucket.files.get(RECAP_PATH)!.save.mockRejectedValue(new Error('gcs down'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.stage).toBe('upload');
    expect(err.artifact).toBe('recap');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-ingest`
Expected: FAIL — cannot find module `./eminiplayer-ingest.service`.

- [ ] **Step 4: Write the implementation**

`backend/src/eminiplayer/eminiplayer-ingest.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Bucket } from '@google-cloud/storage';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { TranscriptService } from '../transcript/transcript.service';
import { EminiplayerService } from './eminiplayer.service';
import { ArchiveNotFoundError } from './eminiplayer.constants';
import { IngestStageError } from './eminiplayer-ingest.errors';

export interface IngestFileReport {
  storagePath: string;
  status: 'uploaded' | 'skipped';
}

export interface IngestResult {
  date: string;
  recapDate: string;
  /** Old *_ES_RECAP.md objects deleted because their date no longer matches. */
  staleRecapsRemoved: string[];
  files: {
    recap: IngestFileReport;
    tradePlanMd: IngestFileReport;
    tradePlanPdf: IngestFileReport;
  };
}

type Artifact = 'recap' | 'tradePlanMd' | 'tradePlanPdf';
type Stage = 'plan' | 'resolve' | 'transcribe' | 'download' | 'upload';

/**
 * Orchestrates one day's document group: resolve archive entries, transcribe
 * the two videos, download the TP pdf, upload each artifact to Storage as soon
 * as it is produced (so a mid-run failure preserves progress and a retry
 * resumes via fill-and-skip). Storage layout mirrors the local
 * knowledge-base/es/<MMDDYYYY>/ folders exactly. Concurrent requests for the
 * same date coalesce onto one in-flight run — the realistic trigger is a
 * client retrying after a timeout while the first run still holds the
 * serialized browser page.
 */
@Injectable()
export class EminiplayerIngestService {
  private readonly logger = new Logger(EminiplayerIngestService.name);
  private readonly inflight = new Map<string, Promise<IngestResult>>();

  constructor(
    private readonly eminiplayer: EminiplayerService,
    private readonly transcript: TranscriptService,
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
  ) {}

  async ingest(date: string, force = false): Promise<IngestResult> {
    // Same-date coalescing: a second request attaches to the in-flight run
    // (its force setting is inherited) instead of re-scraping behind it.
    const existing = this.inflight.get(date);
    if (existing) return existing;
    const run = this.run(date, force).finally(() => this.inflight.delete(date));
    this.inflight.set(date, run);
    return run;
  }

  private async run(date: string, force: boolean): Promise<IngestResult> {
    // Resolution always runs, even when every artifact exists: the recap
    // filename embeds the recap date, which only the archive listing knows.
    const entries = await this.stage('resolve', 'archive', () =>
      this.eminiplayer.findDayEntries(date),
    );
    const recapDate = entries.recap.date;
    const dir = `knowledge-base/es/${date}`;
    const paths: Record<Artifact, string> = {
      recap: `${dir}/${recapDate}_ES_RECAP.md`,
      tradePlanMd: `${dir}/${date}_ES_TP.md`,
      tradePlanPdf: `${dir}/${date}_ES_TP.pdf`,
    };

    const staleRecapsRemoved = await this.removeStaleRecaps(dir, paths.recap);

    const recap = await this.produce('recap', paths.recap, force, async () => ({
      data: await this.transcribe('recap', entries.recap.pageUrl),
      contentType: 'text/markdown',
    }));
    const tradePlanMd = await this.produce('tradePlanMd', paths.tradePlanMd, force, async () => ({
      data: await this.transcribe('tradePlanMd', entries.tradePlan.pageUrl),
      contentType: 'text/markdown',
    }));
    const tradePlanPdf = await this.produce('tradePlanPdf', paths.tradePlanPdf, force, async () => ({
      data: await this.stage('download', 'tradePlanPdf', () =>
        this.eminiplayer.downloadTradePlanPdf(entries.tradePlan.pageUrl),
      ),
      contentType: 'application/pdf',
    }));

    return { date, recapDate, staleRecapsRemoved, files: { recap, tradePlanMd, tradePlanPdf } };
  }

  /**
   * The recap filename embeds a date resolved fresh from the archive each
   * run. A run that happened before the previous session's recap was posted
   * resolved an older recap; its file is now stale, and fill-and-skip alone
   * would let a retry add a second recap beside it. Delete any *_ES_RECAP.md
   * in the day folder that isn't the currently-resolved path, so a day group
   * can never accumulate two recaps.
   */
  private async removeStaleRecaps(dir: string, recapPath: string): Promise<string[]> {
    return this.stage('plan', 'recap', async () => {
      const [files] = await this.bucket.getFiles({ prefix: `${dir}/` });
      const stale = files.filter(
        (f) => f.name.endsWith('_ES_RECAP.md') && f.name !== recapPath,
      );
      for (const f of stale) {
        this.logger.warn(`removing stale recap ${f.name}`);
        await f.delete();
      }
      return stale.map((f) => f.name);
    });
  }

  /** Scrape the page's YouTube url and convert it to transcript markdown. */
  private async transcribe(artifact: Artifact, pageUrl: string): Promise<string> {
    const youtubeUrl = await this.stage('resolve', artifact, () =>
      this.eminiplayer.getYoutubeUrl(pageUrl),
    );
    return this.stage('transcribe', artifact, () => this.transcript.toMarkdown(youtubeUrl));
  }

  /** Fill-and-skip: produce + upload only when missing (or force). */
  private async produce(
    artifact: Artifact,
    storagePath: string,
    force: boolean,
    make: () => Promise<{ data: string | Buffer; contentType: string }>,
  ): Promise<IngestFileReport> {
    const file = this.bucket.file(storagePath);
    if (!force) {
      // 'plan' stage: a GCS failure here happened before anything was
      // produced or uploaded — don't misreport it as an upload failure.
      const [exists] = await this.stage('plan', artifact, () => file.exists());
      if (exists) {
        this.logger.log(`skip ${storagePath} (exists)`);
        return { storagePath, status: 'skipped' };
      }
    }
    const { data, contentType } = await make();
    await this.stage('upload', artifact, () => file.save(data, { contentType }));
    this.logger.log(`uploaded ${storagePath}`);
    return { storagePath, status: 'uploaded' };
  }

  /** Wrap stage failures with context; ArchiveNotFoundError passes through. */
  private async stage<T>(
    stage: Stage,
    artifact: 'archive' | Artifact,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ArchiveNotFoundError) throw err;
      throw new IngestStageError(stage, artifact, err as Error);
    }
  }
}
```

The `getYoutubeUrl` scrape uses stage `'resolve'` with the artifact name; `'plan'` covers pre-production storage work (existence checks, stale-recap cleanup) so those failures aren't misattributed to `'upload'`.

- [ ] **Step 5: Wire the module**

`backend/src/eminiplayer/eminiplayer.module.ts` becomes:

```ts
import { Module } from '@nestjs/common';
import { TranscriptModule } from '../transcript/transcript.module';
import { PlaywrightService } from './playwright.service';
import { EminiplayerService } from './eminiplayer.service';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';

@Module({
  imports: [TranscriptModule],
  providers: [PlaywrightService, EminiplayerService, EminiplayerIngestService],
  // PlaywrightService is deliberately NOT exported: the shared page has a
  // single owner and all access must go through EminiplayerService.
  exports: [EminiplayerService, EminiplayerIngestService],
})
export class EminiplayerModule {}
```

(`FirebaseModule` is `@Global()` and exports `STORAGE_BUCKET`, so it is NOT imported here — same as every other consumer module.)

- [ ] **Step 6: Run the ingest tests**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-ingest`
Expected: PASS.

- [ ] **Step 7: Fix `eminiplayer.module.spec.ts`, then run the full suite**

The existing `eminiplayer.module.spec.ts` compiles `EminiplayerModule` in a testing module whose only other import is `ConfigModule`. Now that the module provides `EminiplayerIngestService` (which injects `STORAGE_BUCKET`), `.compile()` **will fail** with `Nest can't resolve dependencies of the EminiplayerIngestService (EminiplayerService, TranscriptService, ?)` — `FirebaseModule`'s `@Global()` providers only exist when that module is somewhere in the compiled graph, and in this spec it isn't. Do NOT import the real `FirebaseModule` (its factory calls `getStorage(app).bucket()` — a live-bucket dependency the constraints forbid). Instead add a stub global module to that spec's testing-module imports:

```ts
import { Global, Module } from '@nestjs/common';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';

@Global()
@Module({
  providers: [{ provide: STORAGE_BUCKET, useValue: {} }],
  exports: [STORAGE_BUCKET],
})
class FakeFirebaseModule {}
```

and include `FakeFirebaseModule` in the `imports` array of the testing module alongside `ConfigModule`. (A root-level provider would not work — providers passed to `Test.createTestingModule` aren't visible inside `EminiplayerModule`'s own DI context; a global module's exports are.)

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/eminiplayer
git commit -m "feat(eminiplayer): ingest orchestrator with fill-and-skip storage uploads"
```

---

### Task 4: EminiplayerController + wiring + docs

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer.controller.ts`
- Test: `backend/src/eminiplayer/eminiplayer.controller.spec.ts`
- Modify: `backend/src/app.module.ts` (register controller)
- Modify: `backend/README.md` (document the endpoint)

**Interfaces:**
- Consumes: `EminiplayerIngestService.ingest(date, force) → Promise<IngestResult>` and `IngestStageError` (Task 3); `ArchiveNotFoundError` from `eminiplayer.constants.ts` (Task 2).
- Produces: `POST /eminiplayer/ingest?date=MMDDYYYY&force=true|false` → 200 `IngestResult` | 400 | 404 | 502. (200, not Nest's POST-default 201 — the handler carries `@HttpCode(200)`.)

- [ ] **Step 1: Write the failing tests**

`backend/src/eminiplayer/eminiplayer.controller.spec.ts`:

```ts
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EminiplayerController } from './eminiplayer.controller';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import { IngestStageError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';

const RESULT = {
  date: '07012026',
  recapDate: '06302026',
  staleRecapsRemoved: [],
  files: {
    recap: { storagePath: 'knowledge-base/es/07012026/06302026_ES_RECAP.md', status: 'uploaded' },
    tradePlanMd: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.md', status: 'uploaded' },
    tradePlanPdf: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.pdf', status: 'uploaded' },
  },
};

async function build() {
  const ingest = { ingest: jest.fn(() => Promise.resolve(RESULT)) };
  const moduleRef = await Test.createTestingModule({
    controllers: [EminiplayerController],
    providers: [{ provide: EminiplayerIngestService, useValue: ingest }],
  }).compile();
  return { controller: moduleRef.get(EminiplayerController), ingest };
}

describe('POST /eminiplayer/ingest', () => {
  it('delegates with parsed args and returns the result', async () => {
    const { controller, ingest } = await build();
    await expect(controller.ingest('07012026', 'true')).resolves.toEqual(RESULT);
    expect(ingest.ingest).toHaveBeenCalledWith('07012026', true);
  });

  it('defaults force to false when the query param is absent', async () => {
    const { controller, ingest } = await build();
    await controller.ingest('07012026', undefined);
    expect(ingest.ingest).toHaveBeenCalledWith('07012026', false);
  });

  it.each([
    [undefined, 'missing'],
    ['2026-07-01', 'wrong format'],
    ['07012026x', 'trailing junk'],
    ['13012026', 'month 13'],
    ['02302026', 'Feb 30'],
  ])('rejects date %p (%s) with 400 before touching the service', async (bad) => {
    const { controller, ingest } = await build();
    await expect(controller.ingest(bad as string | undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('maps ArchiveNotFoundError to 404', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(new ArchiveNotFoundError('no TP for 07012026'));
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(NotFoundException);
  });

  it('maps IngestStageError to 502', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(
      new IngestStageError('resolve', 'archive', new Error('selectors not implemented yet')),
    );
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(BadGatewayException);
  });

  it('lets unknown errors propagate untouched', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(new TypeError('bug'));
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer.controller`
Expected: FAIL — cannot find module `./eminiplayer.controller`.

- [ ] **Step 3: Write the controller**

`backend/src/eminiplayer/eminiplayer.controller.ts`:

```ts
import {
  BadGatewayException,
  BadRequestException,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { EminiplayerIngestService, IngestResult } from './eminiplayer-ingest.service';
import { IngestStageError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';

/** MMDDYYYY, and a real calendar date (rejects 13012026 and 02302026). */
function isValidMmddyyyy(date: string): boolean {
  if (!/^\d{8}$/.test(date)) return false;
  const mm = Number(date.slice(0, 2));
  const dd = Number(date.slice(2, 4));
  const yyyy = Number(date.slice(4));
  const parsed = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    parsed.getUTCFullYear() === yyyy &&
    parsed.getUTCMonth() === mm - 1 &&
    parsed.getUTCDate() === dd
  );
}

@Controller('eminiplayer')
export class EminiplayerController {
  constructor(private readonly ingestService: EminiplayerIngestService) {}

  @Post('ingest')
  @HttpCode(200) // idempotent-ish operator action, not resource creation
  async ingest(
    @Query('date') date: string | undefined,
    @Query('force') force: string | undefined,
  ): Promise<IngestResult> {
    if (!date || !isValidMmddyyyy(date)) {
      throw new BadRequestException('Query param "date" (MMDDYYYY) is required');
    }
    try {
      return await this.ingestService.ingest(date, force === 'true');
    } catch (err) {
      if (err instanceof ArchiveNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof IngestStageError) throw new BadGatewayException(err.message);
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run the controller tests**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer.controller`
Expected: PASS.

- [ ] **Step 5: Register in AppModule**

In `backend/src/app.module.ts`, add to the imports at the top:

```ts
import { EminiplayerController } from './eminiplayer/eminiplayer.controller';
```

and append `EminiplayerController` to the existing `controllers: [...]` array (repo convention: controllers are declared on `AppModule`, e.g. `MarketDataController`, `BenchmarkController`).

- [ ] **Step 6: Document the endpoint**

In `backend/README.md`, extend the "EminiPlayer scraper (Playwright)" section with (note the four-backtick outer fence so the inner bash fence survives rendering):

````markdown
### Ingest a day's document group

```bash
curl -X POST "localhost:3000/eminiplayer/ingest?date=07012026"
# force regeneration of artifacts that already exist in Storage:
curl -X POST "localhost:3000/eminiplayer/ingest?date=07012026&force=true"
```

Scrapes the archive for the date's Trade Plan entry and the most recent Recap
entry before it, transcribes both YouTube videos, downloads the TP pdf, and
uploads all three to Firebase Storage under `knowledge-base/es/<date>/`
(mirroring the local knowledge-base layout). Artifacts already in Storage are
skipped unless `force=true`; each artifact uploads as soon as it's produced,
so a failed run resumes where it left off. Stale recap files from earlier
runs (a recap resolved before the latest one was posted) are deleted and
reported in `staleRecapsRemoved`. Concurrent requests for the same date
share one run. Expect a request to take tens of seconds up to minutes: it
drives a real browser plus two transcript fetches and a pdf download.

**Current status:** the scraper's selector internals are stubbed — the
endpoint returns a `502` naming the failing stage (`resolve (archive)`)
until the follow-up selector work lands. Errors: `400` bad date, `404` no
matching archive entry, `502` scrape/transcribe/download/upload failure.
````

- [ ] **Step 7: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 8: Boot smoke test (validation path only)**

The ingest happy path is NOT smoke-tested here: even the stubbed pipeline performs real Playwright navigation (and a login attempt) against live eminiplayer.net before reaching its `selectors not implemented yet` throw, and its 502 body varies with credentials/network — exercising it would violate the no-live-site constraint. Smoke only boot + controller wiring via the 400 path:

```bash
cd backend && BENCHMARK_SCHEDULER=false pnpm start:dev &
sleep 8
curl -s -o /dev/null -w '%{http_code}\n' -X POST "localhost:3000/eminiplayer/ingest?date=bad"
curl -s -X POST "localhost:3000/eminiplayer/ingest?date=bad" | head -c 400; echo
kill %1
```

Expected: `400`, and a JSON body mentioning `MMDDYYYY`. (If you *choose* to hit a real date locally with credentials configured, expect a 502 whose message names the `resolve (archive)` stage — the exact text depends on credentials/network, and the call does scrape the live site.)

- [ ] **Step 9: Commit**

```bash
git add backend/src/eminiplayer backend/src/app.module.ts backend/README.md
git commit -m "feat(eminiplayer): POST /eminiplayer/ingest endpoint with date validation and error mapping"
```
