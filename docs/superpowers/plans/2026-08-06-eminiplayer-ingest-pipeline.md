# EminiPlayer Ingest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /eminiplayer/ingest?date=MMDDYYYY` scrapes eminiplayer.net for the day's Trade Plan (video + PDF) and the previous day's Recap video, transcribes both videos to markdown, verifies everything through layered checks (deterministic gates, redundant date cross-checks, LLM content verification), and commits the three documents to Firebase Storage under `knowledge-base/es/<date>/` behind a manifest — plus `GET /eminiplayer/audit` to re-verify the whole corpus. Scraper selector internals ship as structured stubs.

**Architecture:** A site-agnostic `TranscriptModule` (YouTube segments + oEmbed titles + the ported markdown formatter); three stubbed scraper contract methods on `EminiplayerService`; a pure validation module (gates/cross-checks); an LLM verify service on the existing `LLM_PROVIDER` seam; a manifest service (Storage manifest + Firestore video-id uniqueness); an orchestrator wiring it all with fill-and-skip + manifest-gated commitment; a thin controller; an audit service. Spec: `docs/superpowers/specs/2026-08-06-eminiplayer-ingest-pipeline-design.md`.

**Tech Stack:** NestJS (CommonJS TS), `youtube-transcript@1.3.1`, global `fetch` (Node ≥ 20) for oEmbed, `@google-cloud/storage` Bucket via `STORAGE_BUCKET`, Firestore via `FIRESTORE`, `LLM_PROVIDER` seam (`LlmProvider.messageStructured`), Playwright (existing `PlaywrightService`), `node:crypto` sha256, jest.

## Global Constraints

- All work happens in `backend/` (its own package — run `pnpm` commands from `backend/`).
- Transcript markdown format must be byte-identical to the root `src/transcript.js` output: `# Transcript\n\n` header, `**MM:SS** text` lines (`H:MM:SS` from one hour up), trailing newline.
- Dates are `MMDDYYYY` strings everywhere (matches `knowledge-base/es/` folder names).
- Storage paths: `knowledge-base/es/<date>/<recapDate>_ES_RECAP.md`, `<date>_ES_TP.md`, `<date>_ES_TP.pdf`, `manifest.json`.
- **Manifest is the trust gate:** `manifest.json` is written last, only after every check passes; consumers only read manifested days. Skip skips *production*, never *verification*.
- Scraper extraction points throw `eminiplayer: <method> selectors not implemented yet` — no selector work in this plan.
- All `EminiplayerService` page access runs inside `this.playwright.withPage(...)`; every method re-asserts its landed URL.
- Firestore video-id claims live in collection `eminiplayer-video-ids` (doc id = YouTube video id).
- No live-site, live-YouTube, live-LLM, or live-bucket/Firestore tests. Unit tests only, jest, collaborators mocked, `*.spec.ts` alongside sources.
- Semantic commit messages; no AI attributions in commits.
- Run tests with `pnpm test --testPathPattern=<pattern>` from `backend/` (no `--` separator — pnpm forwards it into jest's argv where it breaks pattern flags).

---

### Task 1: TranscriptService (YouTube segments + oEmbed title)

**Files:**
- Create: `backend/src/transcript/transcript.service.ts`
- Create: `backend/src/transcript/transcript.module.ts`
- Test: `backend/src/transcript/transcript.service.spec.ts`
- Modify: `backend/package.json` (add dependency)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `TranscriptModule` (exports `TranscriptService`); `TranscriptService.fetchSegments(urlOrId: string): Promise<TranscriptSegment[]>`; `TranscriptService.fetchVideoTitle(videoId: string): Promise<string>` (oEmbed 4xx throws `class VideoUnavailableError extends Error` — exported, permanent condition; 5xx/network throw plain `Error`); pure exports `decodeEntities(text: string): string`, `formatOffset(seconds: number): string`, `transcriptToMarkdown(segments: TranscriptSegment[]): string`, `interface TranscriptSegment { text: string; offset: number }` (offset in seconds).

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
  VideoUnavailableError,
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

  it('matches the real knowledge-base shape byte-for-byte at scale (entities, hour boundary)', () => {
    // Real-shaped fixture: dozens of lines, entity-bearing text, and lines
    // crossing the one-hour H:MM:SS boundary — the shapes where formatting
    // drift would actually show.
    const segments = [
      ...Array.from({ length: 40 }, (_, i) => ({
        text: i % 7 === 0 ? `zone ${i} &amp; the 7481.75 to 95&#39;s area` : `segment ${i} of the session narrative`,
        offset: i * 89.5,
      })),
      { text: 'now past the hour &quot;mark&quot;', offset: 3601 },
      { text: 'closing remarks &lt;end&gt;', offset: 3725.9 },
    ];
    const expectedLines = [
      ...Array.from({ length: 40 }, (_, i) => {
        const t = Math.floor(i * 89.5);
        const h = Math.floor(t / 3600);
        const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        const stamp = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
        const text = i % 7 === 0 ? `zone ${i} & the 7481.75 to 95's area` : `segment ${i} of the session narrative`;
        return `**${stamp}** ${text}`;
      }),
      '**1:00:01** now past the hour "mark"',
      '**1:02:05** closing remarks <end>',
    ];
    expect(transcriptToMarkdown(segments)).toBe(`# Transcript\n\n${expectedLines.join('\n')}\n`);
  });
});

describe('TranscriptService.fetchSegments', () => {
  beforeEach(() => fetchTranscript.mockReset());

  it('fetches and normalizes ms offsets to seconds', async () => {
    // youtube-transcript@1.3.1 returns offset/duration in MILLISECONDS (srv3 path)
    fetchTranscript.mockResolvedValue([
      { text: 'hello', offset: 0, duration: 2000 },
      { text: 'world', offset: 61000, duration: 1500 },
    ]);
    const segments = await new TranscriptService().fetchSegments('https://youtu.be/abc123');
    expect(fetchTranscript).toHaveBeenCalledWith('https://youtu.be/abc123');
    expect(segments).toEqual([
      { text: 'hello', offset: 0 },
      { text: 'world', offset: 61 },
    ]);
  });

  it('wraps fetch failures with context', async () => {
    fetchTranscript.mockRejectedValue(new Error('boom'));
    await expect(new TranscriptService().fetchSegments('abc123')).rejects.toThrow(
      'transcript fetch failed for abc123: boom',
    );
  });
});

describe('TranscriptService.fetchVideoTitle', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns the title from the oEmbed response', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ title: 'ES Recap/Video Lesson for Tuesday 06/30/2026' }),
      }),
    ) as unknown as typeof fetch;
    const title = await new TranscriptService().fetchVideoTitle('abc123');
    expect(title).toBe('ES Recap/Video Lesson for Tuesday 06/30/2026');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('youtube.com/oembed');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('abc123');
  });

  it('throws VideoUnavailableError on a 4xx (deleted/private/unembeddable video — permanent)', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 404 }),
    ) as unknown as typeof fetch;
    const err = await new TranscriptService().fetchVideoTitle('abc123').catch((e) => e);
    expect(err).toBeInstanceOf(VideoUnavailableError);
    expect(err.message).toContain('HTTP 404');
  });

  it('throws a plain Error on a 5xx (transient — retryable transport failure)', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 503 }),
    ) as unknown as typeof fetch;
    const err = await new TranscriptService().fetchVideoTitle('abc123').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VideoUnavailableError);
    expect(err.message).toContain('HTTP 503');
  });

  it('throws when the response has no title', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    ) as unknown as typeof fetch;
    await expect(new TranscriptService().fetchVideoTitle('abc123')).rejects.toThrow(
      'oEmbed response for abc123 has no title',
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && pnpm test --testPathPattern=transcript.service`
Expected: FAIL — cannot find module `./transcript.service`.

- [ ] **Step 4: Write the implementation**

`backend/src/transcript/transcript.service.ts` — a direct port of root `src/transcript.js` plus the ms→s normalization from root `src/transcript-command.js`, plus oEmbed:

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
// would compress 1000x — a known limitation shared with the root package's
// src/transcript-command.js, kept identical for byte-parity. The ingest
// pipeline's transcript gate rejects such compressed output instead of
// storing it (see eminiplayer-validation.ts).
const OFFSET_DIVISOR = 1000;

/**
 * The video exists-check failed on YouTube's side (deleted, private, or
 * embedding disabled) — a PERMANENT data condition, not a transient fault.
 * Callers must not treat this as retryable transport failure.
 */
export class VideoUnavailableError extends Error {}

/**
 * Site-agnostic YouTube access. fetchSegments' downstream markdown format is
 * byte-identical to the root package's `backtest transcript` CLI, which
 * produced the existing knowledge-base/es transcript files. fetchVideoTitle
 * uses YouTube's public oEmbed endpoint — no API key required.
 */
@Injectable()
export class TranscriptService {
  async fetchSegments(urlOrId: string): Promise<TranscriptSegment[]> {
    let raw: Array<{ text: string; offset: number }>;
    try {
      raw = await YoutubeTranscript.fetchTranscript(urlOrId);
    } catch (err) {
      throw new Error(
        `transcript fetch failed for ${urlOrId}: ${(err as Error).message}`,
      );
    }
    return raw.map((seg) => ({ text: seg.text, offset: seg.offset / OFFSET_DIVISOR }));
  }

  async fetchVideoTitle(videoId: string): Promise<string> {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    let res: Response;
    try {
      res = await fetch(oembedUrl);
    } catch (err) {
      throw new Error(`oEmbed fetch failed for ${videoId}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const message = `oEmbed fetch failed for ${videoId}: HTTP ${res.status}`;
      // 4xx = the video itself is gone/private/unembeddable (permanent);
      // 5xx = YouTube-side transient, plain error so callers may retry.
      if (res.status >= 400 && res.status < 500) throw new VideoUnavailableError(message);
      throw new Error(message);
    }
    const body = (await res.json()) as { title?: string };
    if (!body.title) {
      throw new Error(`oEmbed response for ${videoId} has no title`);
    }
    return body.title;
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
git commit -m "feat(transcript): YouTube segments + oEmbed title service (ported transcript formatter)"
```

---

### Task 2: EminiplayerService scraper contracts (stubbed)

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer.constants.ts` (add types + errors + constants)
- Modify: `backend/src/eminiplayer/eminiplayer.service.ts` (refactor + 3 new methods)
- Test: `backend/src/eminiplayer/eminiplayer.service.spec.ts` (extend)

**Interfaces:**
- Consumes: existing `PlaywrightService.withPage(fn)`, existing private login/goto helpers.
- Produces (used by Tasks 3–8):
  - `interface ArchiveEntry { date: string; pageUrl: string; title: string }` (`date` is `MMDDYYYY`) — in `eminiplayer.constants.ts`
  - `interface DayEntries { tradePlan: ArchiveEntry; recap: ArchiveEntry }` — in `eminiplayer.constants.ts`
  - `class ArchiveNotFoundError extends Error`, `const RECAP_LOOKBACK_DAYS = 14`, `const INGEST_PIPELINE_VERSION = 1` — in `eminiplayer.constants.ts`. Not-found is the **scraper's** contract: once selectors land, `findDayEntries` throws `ArchiveNotFoundError` when the date has no TP entry or no recap within the lookback window; the ingest layer passes it through untouched and the controller maps it to 404.
  - `EminiplayerService.findDayEntries(date: string): Promise<DayEntries>` — contract includes **three-way date agreement** (row date = title-printed date = title-printed weekday's actual calendar day).
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

  it('getYoutubeUrl accepts www <-> apex host canonicalization (same path)', async () => {
    // requested www, landed on apex — the host variance assertOnArchivePage
    // already tolerates; must reach the extraction point, not a nav error
    const detailUrl = 'https://www.eminiplayer.net/post/some-entry.aspx';
    const page = makePage({ url: jest.fn(() => 'https://eminiplayer.net/post/some-entry.aspx') });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(
      'eminiplayer: getYoutubeUrl selectors not implemented yet',
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

- [ ] **Step 3: Add types, error, and constants to `eminiplayer.constants.ts`**

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

/** Stamped into every manifest; bump when pipeline behavior changes. */
export const INGEST_PIPELINE_VERSION = 1;
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
 * Hostname comparison tolerates www. <-> apex canonicalization — the same
 * host variance assertOnArchivePage deliberately accepts — while keeping the
 * pathname check exact.
 */
private assertOnPage(page: Page, expectedUrl: string): void {
  const url = new URL(page.url());
  const expected = new URL(expectedUrl);
  const normalizeHost = (h: string) => h.replace(/^www\./, '');
  const landed =
    normalizeHost(url.hostname) === normalizeHost(expected.hostname) &&
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
    // selector follow-up:
    //  - THREE-WAY DATE AGREEMENT: only return an entry when the row's date,
    //    the date printed in the entry title ("...for Tuesday 04/10/2018"),
    //    and the title's printed weekday (vs what that calendar date actually
    //    falls on) all agree — an off-by-one-row parse must fail loudly, not
    //    file a document under the wrong day.
    //  - throw ArchiveNotFoundError (eminiplayer.constants) when there is no
    //    TP entry for `date`, or no recap entry dated within
    //    RECAP_LOOKBACK_DAYS calendar days strictly before it — the
    //    controller maps that to 404, and the bound keeps the scan from
    //    walking the whole multi-year archive inside this withPage callback.
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
git commit -m "feat(eminiplayer): stubbed scraper contracts with landed-URL asserts and not-found ownership"
```

---

### Task 3: Validation module (pure gates and cross-checks)

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-ingest.errors.ts`
- Create: `backend/src/eminiplayer/eminiplayer-validation.ts`
- Test: `backend/src/eminiplayer/eminiplayer-validation.spec.ts`

**Interfaces:**
- Consumes: `RECAP_LOOKBACK_DAYS` (Task 2).
- Produces (used by Tasks 4–8):
  - `class IngestStageError extends Error { readonly stage: 'plan'|'resolve'|'transcribe'|'download'|'verify'|'upload'|'commit'; readonly artifact: 'archive'|'recap'|'tradePlanMd'|'tradePlanPdf' }` — in the errors file
  - `class IngestValidationError extends Error` — in the errors file; maps to HTTP 422
  - Pure functions in `eminiplayer-validation.ts`: `parseMmddyyyy(date: string): Date`, `isWeekday(date: string): boolean`, `assertDayInvariants(date: string, recapDate: string): void`, `extractYoutubeVideoId(url: string): string`, `type VideoFlavor = 'recap' | 'tradePlan'`, `assertVideoTitle(title: string, expectedDate: string, flavor: VideoFlavor): void` (distinguishes contradictory-date from no-recognizable-date), `assertTranscriptMarkdown(markdown: string, label: string): void`, `assertPdfBuffer(buf: Buffer, label: string): void`, `sha256Hex(data: string | Buffer): string`, `md5Base64(data: string | Buffer): string`, plus exported threshold constants and the storage-layout single source: `ES_STORAGE_PREFIX`, `manifestPath(date): string`, `dayPaths(date, recapDate): DayPaths` (`{ dir, recap, tradePlanMd, tradePlanPdf, manifest }`).

- [ ] **Step 1: Write the errors file**

`backend/src/eminiplayer/eminiplayer-ingest.errors.ts` (the 404 not-found signal is NOT here — it's `ArchiveNotFoundError` in `eminiplayer.constants.ts`, owned by the scraper layer that is the only layer able to detect it):

```ts
/**
 * A pipeline stage failed. Maps to HTTP 502 (retryable as-is). Stages:
 * 'plan' (storage existence checks / reloads / stale-recap cleanup),
 * 'resolve' (scraping), 'transcribe' (YouTube transcript fetch),
 * 'download' (pdf), 'verify' (oEmbed / LLM transport), 'upload' (bucket
 * save), 'commit' (manifest write / video-id claim transport).
 * Already-uploaded artifacts remain in the bucket, so a retry resumes via
 * fill-and-skip. ArchiveNotFoundError and IngestValidationError deliberately
 * do NOT get wrapped into this — they pass through to the controller's
 * 404/422 mappings.
 */
export class IngestStageError extends Error {
  constructor(
    readonly stage: 'plan' | 'resolve' | 'transcribe' | 'download' | 'verify' | 'upload' | 'commit',
    readonly artifact: 'archive' | 'recap' | 'tradePlanMd' | 'tradePlanPdf',
    cause: Error,
  ) {
    super(`eminiplayer ingest failed at ${stage} (${artifact}): ${cause.message}`);
  }
}

/**
 * We got data and refuse to trust it: a deterministic gate, date cross-check,
 * structural invariant, LLM verdict, or video-id uniqueness claim failed.
 * Maps to HTTP 422 (NOT retryable as-is — the source data or our expectations
 * are wrong and a human must look). No manifest is written; the day stays
 * invisible to consumers; artifacts stay in place for diagnosis.
 */
export class IngestValidationError extends Error {}
```

- [ ] **Step 2: Write the failing tests**

`backend/src/eminiplayer/eminiplayer-validation.spec.ts`:

```ts
import {
  assertDayInvariants,
  assertPdfBuffer,
  assertTranscriptMarkdown,
  assertVideoTitle,
  dayPaths,
  extractYoutubeVideoId,
  isWeekday,
  manifestPath,
  md5Base64,
  parseMmddyyyy,
  sha256Hex,
  TRANSCRIPT_MIN_LINES,
} from './eminiplayer-validation';
import { IngestValidationError } from './eminiplayer-ingest.errors';

/** Builds a plausible transcript markdown: `lines` timestamped lines, 4s apart. */
function fixtureMarkdown(lines: number, opts: { startSeconds?: number; stepSeconds?: number } = {}): string {
  const { startSeconds = 0, stepSeconds = 4 } = opts;
  const rows: string[] = [];
  for (let i = 0; i < lines; i++) {
    const t = startSeconds + i * stepSeconds;
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    rows.push(`**${mm}:${ss}** segment number ${i} with enough words to add up`);
  }
  return `# Transcript\n\n${rows.join('\n')}\n`;
}

/** Minimal buffer that satisfies every PDF heuristic. */
function fixturePdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'),
    Buffer.alloc(12000, 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);
}

describe('parseMmddyyyy / isWeekday', () => {
  it('parses MMDDYYYY to a UTC date', () => {
    const d = parseMmddyyyy('07012026');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(6);
    expect(d.getUTCDate()).toBe(1);
  });

  it('classifies weekdays and weekends', () => {
    expect(isWeekday('07012026')).toBe(true); // Wed
    expect(isWeekday('07042026')).toBe(false); // Sat
  });
});

describe('assertDayInvariants', () => {
  it('accepts a normal adjacent-weekday pair', () => {
    expect(() => assertDayInvariants('07012026', '06302026')).not.toThrow();
  });

  it.each([
    ['07012026', '07012026', 'recap not before date'],
    ['07012026', '07022026', 'recap after date'],
    ['07012026', '06102026', 'gap beyond lookback'],
    ['07042026', '07022026', 'date is a weekend'],
    ['07062026', '07042026', 'recap is a weekend'],
  ])('rejects %s/%s (%s)', (date, recapDate) => {
    expect(() => assertDayInvariants(date, recapDate)).toThrow(IngestValidationError);
  });
});

describe('extractYoutubeVideoId', () => {
  it.each([
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('extracts from %s', (url, id) => {
    expect(extractYoutubeVideoId(url)).toBe(id);
  });

  it.each([
    ['https://vimeo.com/12345'],
    ['https://www.youtube.com/watch'],
    ['https://www.eminiplayer.net/archive.aspx'],
  ])('rejects %s', (url) => {
    expect(() => extractYoutubeVideoId(url)).toThrow(IngestValidationError);
  });
});

describe('assertVideoTitle', () => {
  // Fixture weekdays are calendar-correct (06/30/2026 = Tuesday, 07/01/2026 =
  // Wednesday). assertVideoTitle deliberately does NOT check weekday-vs-date
  // agreement — that lives in the scraper's three-way check and the LLM
  // referencedWeekday check — but fixtures must not teach the wrong invariant.
  it('accepts matching flavor + date (leading-zero and bare forms)', () => {
    expect(() =>
      assertVideoTitle('ES Recap/Video Lesson for Tuesday 06/30/2026', '06302026', 'recap'),
    ).not.toThrow();
    expect(() =>
      assertVideoTitle('ES Key Zones and Trade Plan for Wednesday 7/1/2026', '07012026', 'tradePlan'),
    ).not.toThrow();
  });

  it('rejects a flavor mismatch (recap video in the TP slot)', () => {
    expect(() =>
      assertVideoTitle('ES Recap/Video Lesson for Tuesday 06/30/2026', '06302026', 'tradePlan'),
    ).toThrow(IngestValidationError);
  });

  it('rejects a contradictory date with a "contains" message', () => {
    expect(() =>
      assertVideoTitle('ES Key Zones and Trade Plan for Thu. 07/02/2026', '07012026', 'tradePlan'),
    ).toThrow('contains 07/02/2026');
  });

  it('distinguishes an unrecognizable date format (our assumption may be wrong) from a contradiction', () => {
    expect(() =>
      assertVideoTitle('ES Key Zones and Trade Plan for July 1st', '07012026', 'tradePlan'),
    ).toThrow('no recognizable M/D/YYYY date');
  });
});

describe('assertTranscriptMarkdown', () => {
  it('accepts a plausible transcript', () => {
    expect(() => assertTranscriptMarkdown(fixtureMarkdown(60), 'recap')).not.toThrow();
  });

  it('rejects too few lines', () => {
    expect(() => assertTranscriptMarkdown(fixtureMarkdown(TRANSCRIPT_MIN_LINES - 1), 'recap')).toThrow(
      IngestValidationError,
    );
  });

  it('rejects a missing header', () => {
    expect(() => assertTranscriptMarkdown('**00:00** hi\n', 'recap')).toThrow(IngestValidationError);
  });

  it('rejects regressing timestamps', () => {
    // filler lines are long enough to clear the char threshold, so the
    // regression (line 2) is the check that actually fires
    const md = `# Transcript\n\n${['**00:10** a first line with plenty of words in it', '**00:05** b second line regressing with plenty of words', ...Array.from({ length: 30 }, (_, i) => `**01:${String(i).padStart(2, '0')}** filler line ${i} with plenty of additional words here`)].join('\n')}\n`;
    expect(() => assertTranscriptMarkdown(md, 'recap')).toThrow('timestamps regress');
  });

  it('rejects an implausibly short duration (catches 1000x ms/s compression)', () => {
    // 60 lines all inside 2 seconds — the compressed shape of a 20-minute video
    expect(() =>
      assertTranscriptMarkdown(fixtureMarkdown(60, { stepSeconds: 0 }), 'recap'),
    ).toThrow('duration');
  });
});

describe('assertPdfBuffer', () => {
  it('accepts a structurally-valid pdf', () => {
    expect(() => assertPdfBuffer(fixturePdf(), 'tradePlanPdf')).not.toThrow();
  });

  it('rejects an HTML error page', () => {
    const html = Buffer.from(`<html><body>error</body></html>${' '.repeat(12000)}`);
    expect(() => assertPdfBuffer(html, 'tradePlanPdf')).toThrow(IngestValidationError);
  });

  it('rejects a truncated pdf (no %%EOF)', () => {
    const buf = Buffer.concat([Buffer.from('%PDF-1.4 /Type /Page '), Buffer.alloc(12000, 0x20)]);
    expect(() => assertPdfBuffer(buf, 'tradePlanPdf')).toThrow('%%EOF');
  });

  it('rejects a tiny file', () => {
    expect(() => assertPdfBuffer(Buffer.from('%PDF-1.4 /Type /Page %%EOF'), 'tradePlanPdf')).toThrow(
      IngestValidationError,
    );
  });
});

describe('hashing', () => {
  it('sha256Hex hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('md5Base64 matches the GCS metadata md5Hash encoding', () => {
    expect(md5Base64('abc')).toBe('kAFQmDzST7DWlj99KOF/cg==');
  });
});

describe('dayPaths', () => {
  it('is the single source of the storage layout', () => {
    expect(dayPaths('07012026', '06302026')).toEqual({
      dir: 'knowledge-base/es/07012026',
      recap: 'knowledge-base/es/07012026/06302026_ES_RECAP.md',
      tradePlanMd: 'knowledge-base/es/07012026/07012026_ES_TP.md',
      tradePlanPdf: 'knowledge-base/es/07012026/07012026_ES_TP.pdf',
      manifest: 'knowledge-base/es/07012026/manifest.json',
    });
    expect(manifestPath('07012026')).toBe('knowledge-base/es/07012026/manifest.json');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-validation`
Expected: FAIL — cannot find module `./eminiplayer-validation`.

- [ ] **Step 4: Write the implementation**

`backend/src/eminiplayer/eminiplayer-validation.ts`:

```ts
import { createHash } from 'node:crypto';
import { RECAP_LOOKBACK_DAYS } from './eminiplayer.constants';
import { IngestValidationError } from './eminiplayer-ingest.errors';

// ---- thresholds (exported so tests and the audit share them) ----
export const TRANSCRIPT_MIN_LINES = 20;
export const TRANSCRIPT_MIN_CHARS = 500;
export const TRANSCRIPT_MIN_DURATION_S = 120; // 2 min
export const TRANSCRIPT_MAX_DURATION_S = 3 * 3600; // 3 h
export const PDF_MIN_BYTES = 10_000;

export type VideoFlavor = 'recap' | 'tradePlan';

export function parseMmddyyyy(date: string): Date {
  const mm = Number(date.slice(0, 2));
  const dd = Number(date.slice(2, 4));
  const yyyy = Number(date.slice(4));
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

export function isWeekday(date: string): boolean {
  const day = parseMmddyyyy(date).getUTCDay();
  return day >= 1 && day <= 5;
}

/** recapDate strictly before date, gap within lookback, both weekdays. */
export function assertDayInvariants(date: string, recapDate: string): void {
  const d = parseMmddyyyy(date).getTime();
  const r = parseMmddyyyy(recapDate).getTime();
  if (!(r < d)) {
    throw new IngestValidationError(`recap date ${recapDate} is not strictly before ${date}`);
  }
  const gapDays = (d - r) / 86_400_000;
  if (gapDays > RECAP_LOOKBACK_DAYS) {
    throw new IngestValidationError(
      `recap date ${recapDate} is ${gapDays} days before ${date} — beyond the ${RECAP_LOOKBACK_DAYS}-day lookback`,
    );
  }
  if (!isWeekday(date)) throw new IngestValidationError(`${date} is not a weekday`);
  if (!isWeekday(recapDate)) throw new IngestValidationError(`recap date ${recapDate} is not a weekday`);
}

export function extractYoutubeVideoId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IngestValidationError(`cannot extract a YouTube video id from ${url}`);
  }
  let id: string | null = null;
  if (parsed.hostname === 'youtu.be') id = parsed.pathname.slice(1) || null;
  else if (/(^|\.)youtube\.com$/.test(parsed.hostname)) {
    if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
    else if (parsed.pathname.startsWith('/embed/')) id = parsed.pathname.split('/')[2] ?? null;
  }
  if (!id || !/^[\w-]{6,20}$/.test(id)) {
    throw new IngestValidationError(`cannot extract a YouTube video id from ${url}`);
  }
  return id;
}

/** "MM/DD/YYYY" and "M/D/YYYY" renderings of a MMDDYYYY date. */
function titleDateForms(date: string): string[] {
  const mm = date.slice(0, 2);
  const dd = date.slice(2, 4);
  const yyyy = date.slice(4);
  return [`${mm}/${dd}/${yyyy}`, `${Number(mm)}/${Number(dd)}/${yyyy}`];
}

// TODO(selectors follow-up): these accepted forms are an ASSUMPTION not yet
// validated against the channel's real titles. Before trusting this gate at
// volume, capture 3-5 real oEmbed titles and encode the observed date/flavor
// forms — a format mismatch would 422 every single day.
const FLAVOR_PATTERNS: Record<VideoFlavor, RegExp> = {
  recap: /recap|video lesson/i,
  tradePlan: /trade plan|key zones/i,
};

const ANY_TITLE_DATE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/;

/**
 * The video's own title must carry the expected date and the right flavor.
 * Distinguishes "the title contradicts the expected date" (wrong video —
 * source data problem) from "the title carries no recognizable date at all"
 * (our format assumption may be wrong) so the two are diagnosable apart.
 */
export function assertVideoTitle(title: string, expectedDate: string, flavor: VideoFlavor): void {
  if (!FLAVOR_PATTERNS[flavor].test(title)) {
    throw new IngestValidationError(
      `video title "${title}" does not look like a ${flavor} video`,
    );
  }
  if (titleDateForms(expectedDate).some((form) => title.includes(form))) return;
  const found = ANY_TITLE_DATE.exec(title);
  if (found) {
    throw new IngestValidationError(
      `video title "${title}" contains ${found[0]} but the expected date is ${expectedDate}`,
    );
  }
  throw new IngestValidationError(
    `video title "${title}" has no recognizable M/D/YYYY date — the title-format assumption may be wrong; verify real oEmbed titles`,
  );
}

const TRANSCRIPT_LINE = /^\*\*(\d+):(\d{2})(?::(\d{2}))?\*\* (.+)$/;

/**
 * Gate over the FINAL markdown (not raw segments) so the same check covers
 * freshly-generated transcripts and ones reloaded from the bucket on resume.
 * The duration bounds double as a tripwire for the youtube-transcript
 * classic-XML path, whose seconds get divided as if they were milliseconds.
 */
export function assertTranscriptMarkdown(markdown: string, label: string): void {
  if (!markdown.startsWith('# Transcript\n\n')) {
    throw new IngestValidationError(`${label} transcript is missing the "# Transcript" header`);
  }
  const offsets: number[] = [];
  let chars = 0;
  for (const line of markdown.split('\n')) {
    const m = TRANSCRIPT_LINE.exec(line);
    if (!m) continue;
    const [, a, b, c, text] = m;
    // "MM:SS" (a=min, b=sec) or "H:MM:SS" (a=hr, b=min, c=sec)
    const seconds = c !== undefined
      ? Number(a) * 3600 + Number(b) * 60 + Number(c)
      : Number(a) * 60 + Number(b);
    offsets.push(seconds);
    chars += text.length;
  }
  if (offsets.length < TRANSCRIPT_MIN_LINES) {
    throw new IngestValidationError(
      `${label} transcript has only ${offsets.length} timestamped lines (min ${TRANSCRIPT_MIN_LINES})`,
    );
  }
  if (chars < TRANSCRIPT_MIN_CHARS) {
    throw new IngestValidationError(
      `${label} transcript has only ${chars} characters of text (min ${TRANSCRIPT_MIN_CHARS})`,
    );
  }
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] < offsets[i - 1]) {
      throw new IngestValidationError(`${label} transcript timestamps regress at line ${i + 1}`);
    }
  }
  const last = offsets[offsets.length - 1];
  if (last < TRANSCRIPT_MIN_DURATION_S || last > TRANSCRIPT_MAX_DURATION_S) {
    throw new IngestValidationError(
      `${label} transcript duration ${last}s is outside the plausible range ` +
        `[${TRANSCRIPT_MIN_DURATION_S}, ${TRANSCRIPT_MAX_DURATION_S}] — possible ms/s unit bug or truncated captions`,
    );
  }
}

/** Structural-only PDF gate: magic bytes, trailer, size, a page marker. */
export function assertPdfBuffer(buf: Buffer, label: string): void {
  if (!buf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new IngestValidationError(`${label} is not a PDF (missing %PDF- magic bytes)`);
  }
  if (buf.length < PDF_MIN_BYTES) {
    throw new IngestValidationError(`${label} is only ${buf.length} bytes (min ${PDF_MIN_BYTES})`);
  }
  if (!buf.includes('%%EOF')) {
    throw new IngestValidationError(`${label} has no %%EOF trailer — likely truncated`);
  }
  if (!/\/Type\s*\/Page/.test(buf.toString('latin1'))) {
    throw new IngestValidationError(`${label} has no page objects`);
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Base64 MD5 — comparable against GCS object metadata's `md5Hash` field. */
export function md5Base64(data: string | Buffer): string {
  return createHash('md5').update(data).digest('base64');
}

// ---- storage layout: the SINGLE home of the knowledge-base/es/ contract ----
// Orchestrator, manifest service, and audit all derive paths from here, so
// the writer and the auditor can never drift apart (an audit whose prefix
// drifted would "audit" nothing and report clean).

export const ES_STORAGE_PREFIX = 'knowledge-base/es/';

export function manifestPath(date: string): string {
  return `${ES_STORAGE_PREFIX}${date}/manifest.json`;
}

export interface DayPaths {
  dir: string;
  recap: string;
  tradePlanMd: string;
  tradePlanPdf: string;
  manifest: string;
}

export function dayPaths(date: string, recapDate: string): DayPaths {
  const dir = `${ES_STORAGE_PREFIX}${date}`;
  return {
    dir,
    recap: `${dir}/${recapDate}_ES_RECAP.md`,
    tradePlanMd: `${dir}/${date}_ES_TP.md`,
    tradePlanPdf: `${dir}/${date}_ES_TP.pdf`,
    manifest: manifestPath(date),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-validation`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/eminiplayer
git commit -m "feat(eminiplayer): pure validation gates, date cross-checks, and typed ingest errors"
```

---

### Task 4: EminiplayerVerifyService (LLM content verification)

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-verify.service.ts`
- Test: `backend/src/eminiplayer/eminiplayer-verify.service.spec.ts`
- Modify: `backend/src/config/configuration.ts` (add `eminiplayer.verifyModel`)
- Modify: `backend/.env.example` (document `EMINIPLAYER_VERIFY_MODEL`)

**Interfaces:**
- Consumes: `LLM_PROVIDER` token (`backend/src/llm/llm.constants`) + `LlmProvider.messageStructured<T>(req, attribution)` (`backend/src/llm/llm.provider`); `IngestValidationError` (Task 3); `parseMmddyyyy`, `VideoFlavor` (Task 3).
- Produces (used by Tasks 5–6): `interface TranscriptVerdict { docType: 'tradePlan'|'recap'|'other'; isEsContent: boolean; referencedWeekday: Weekday|'none'; confidence: 'high'|'medium'|'low' }`; `EminiplayerVerifyService.verifyTranscript(markdown: string, expected: { flavor: VideoFlavor; date: string }): Promise<TranscriptVerdict>` — returns the verdict (manifest evidence) when the transcript verifies; throws `IngestValidationError` on verdict mismatch; lets transport errors propagate as plain `Error` for the orchestrator to wrap as a `'verify'` stage failure.

- [ ] **Step 1: Add config**

In `backend/src/config/configuration.ts`, extend the `eminiplayer` block of `AppConfig` with `verifyModel?: string;` and the factory with:

```ts
    // Model for LLM transcript verification. `|| undefined` convention (see
    // username above): unset/empty means "use the provider's default model".
    // Set a cheap classifier (e.g. Haiku) to cut verification cost.
    verifyModel: process.env.EMINIPLAYER_VERIFY_MODEL || undefined,
```

In `backend/.env.example`, under the EminiPlayer section:

```bash
# Model for LLM transcript verification (unset = provider default model).
EMINIPLAYER_VERIFY_MODEL=
```

Also update `backend/src/config/configuration.spec.ts`: its eminiplayer describe block deletes the existing `EMINIPLAYER_*` env vars in `beforeEach` and asserts the block's exact shape with `toEqual`. Add `delete process.env.EMINIPLAYER_VERIFY_MODEL;` to that `beforeEach` (otherwise any environment with the var exported turns the exact-shape assertion into an environment-dependent full-suite red), and extend the exact-shape expectation with `verifyModel: undefined` plus one override test:

```ts
it('reads EMINIPLAYER_VERIFY_MODEL', () => {
  process.env.EMINIPLAYER_VERIFY_MODEL = 'claude-haiku-4-5';
  expect(configuration().eminiplayer.verifyModel).toBe('claude-haiku-4-5');
});
```

- [ ] **Step 2: Write the failing tests**

`backend/src/eminiplayer/eminiplayer-verify.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { EminiplayerVerifyService } from './eminiplayer-verify.service';
import { IngestValidationError } from './eminiplayer-ingest.errors';

const GOOD_VERDICT = {
  docType: 'recap',
  isEsContent: true,
  referencedWeekday: 'Tuesday',
  confidence: 'high',
};

// 06302026 is a Tuesday
const EXPECTED = { flavor: 'recap' as const, date: '06302026' };
const MARKDOWN = '# Transcript\n\n**00:00** welcome to the recap\n';

async function build(verdict: unknown = GOOD_VERDICT) {
  const llm = { messageStructured: jest.fn(() => Promise.resolve(verdict)) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerVerifyService,
      { provide: LLM_PROVIDER, useValue: llm },
      {
        provide: ConfigService,
        useValue: { get: jest.fn(() => 'test-verify-model') },
      },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerVerifyService), llm };
}

describe('EminiplayerVerifyService.verifyTranscript', () => {
  it('returns the verdict on a match and passes model + schema + attribution', async () => {
    const { service, llm } = await build();
    await expect(service.verifyTranscript(MARKDOWN, EXPECTED)).resolves.toEqual(GOOD_VERDICT);
    const [req, attribution] = llm.messageStructured.mock.calls[0];
    expect(req.model).toBe('test-verify-model');
    expect(req.schema).toBeDefined();
    expect(req.prompt).toContain('welcome to the recap');
    expect(attribution).toEqual({ operation: 'other' });
  });

  it('accepts referencedWeekday "none" (speaker never names the day)', async () => {
    const verdict = { ...GOOD_VERDICT, referencedWeekday: 'none' };
    const { service } = await build(verdict);
    await expect(service.verifyTranscript(MARKDOWN, EXPECTED)).resolves.toEqual(verdict);
  });

  it.each([
    [{ ...GOOD_VERDICT, docType: 'tradePlan' }, 'classified as tradePlan'],
    [{ ...GOOD_VERDICT, docType: 'other' }, 'classified as other'],
    [{ ...GOOD_VERDICT, isEsContent: false }, 'not ES futures content'],
    [{ ...GOOD_VERDICT, referencedWeekday: 'Friday' }, 'references Friday'],
    [{ ...GOOD_VERDICT, confidence: 'low' }, 'low-confidence'],
  ])('throws IngestValidationError on mismatch %#', async (verdict, messagePart) => {
    const { service } = await build(verdict);
    const err = await service.verifyTranscript(MARKDOWN, EXPECTED).catch((e) => e);
    expect(err).toBeInstanceOf(IngestValidationError);
    expect(err.message).toContain(messagePart);
  });

  it('lets transport errors propagate as plain Error', async () => {
    const { service, llm } = await build();
    llm.messageStructured.mockRejectedValue(new Error('api down'));
    const err = await service.verifyTranscript(MARKDOWN, EXPECTED).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(IngestValidationError);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-verify`
Expected: FAIL — cannot find module `./eminiplayer-verify.service`.

- [ ] **Step 4: Write the implementation**

`backend/src/eminiplayer/eminiplayer-verify.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDER } from '../llm/llm.constants';
import type { LlmProvider } from '../llm/llm.provider';
import { IngestValidationError } from './eminiplayer-ingest.errors';
import { parseMmddyyyy, VideoFlavor } from './eminiplayer-validation';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export interface TranscriptVerdict {
  docType: 'tradePlan' | 'recap' | 'other';
  isEsContent: boolean;
  referencedWeekday: (typeof WEEKDAYS)[number] | 'none';
  confidence: 'high' | 'medium' | 'low';
}

// Every enum property carries an explicit `type` — enum-only properties have
// broken structured output on the moonshot provider before.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['docType', 'isEsContent', 'referencedWeekday', 'confidence'],
  properties: {
    docType: { type: 'string', enum: ['tradePlan', 'recap', 'other'] },
    isEsContent: { type: 'boolean' },
    referencedWeekday: { type: 'string', enum: [...WEEKDAYS, 'none'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const SYSTEM = [
  'You classify a transcript of a trading video. Answer only via the schema.',
  'docType: "tradePlan" if the speaker presents a plan for the UPCOMING session (typical opening: "let\'s go over today\'s trade plan"); "recap" if the speaker reviews a COMPLETED session (typical opening: "welcome to today\'s live recap"); otherwise "other".',
  'isEsContent: true only if the content is about ES / E-mini S&P 500 futures trading.',
  'referencedWeekday: the weekday of the session this video PRIMARILY covers (the session being planned or recapped), only if the speaker states or clearly implies it; otherwise "none". IGNORE mentions of the next or previous session ("tomorrow, Wednesday, watch for..." in a recap refers to the NEXT session, not this one). If both are named, answer with the covered session\'s weekday. Never guess.',
  'confidence: your certainty in docType.',
].join('\n');

/** Only the opening minutes are needed to classify; keeps the call cheap. */
const TRANSCRIPT_SNIPPET_CHARS = 6000;

/**
 * LLM content verification (blocking): the only layer that catches "right
 * slot, wrong content" — e.g. the site embedded Monday's video on Tuesday's
 * page. Verdict mismatch throws IngestValidationError (422, human must look);
 * transport failure propagates as plain Error for the orchestrator to wrap
 * as a retryable 'verify' stage failure.
 */
@Injectable()
export class EminiplayerVerifyService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly config: ConfigService,
  ) {}

  async verifyTranscript(
    markdown: string,
    expected: { flavor: VideoFlavor; date: string },
  ): Promise<TranscriptVerdict> {
    const expectedWeekday = WEEKDAYS[parseMmddyyyy(expected.date).getUTCDay()];
    const verdict = await this.llm.messageStructured<TranscriptVerdict>(
      {
        system: SYSTEM,
        prompt: `Transcript (may be truncated):\n\n${markdown.slice(0, TRANSCRIPT_SNIPPET_CHARS)}`,
        schema: VERDICT_SCHEMA,
        model: this.config.get<string>('eminiplayer.verifyModel'),
        maxTokens: 300,
      },
      { operation: 'other' },
    );
    if (verdict.docType !== expected.flavor) {
      throw new IngestValidationError(
        `llm verification: expected a ${expected.flavor} transcript but it classified as ${verdict.docType}`,
      );
    }
    if (!verdict.isEsContent) {
      throw new IngestValidationError('llm verification: transcript is not ES futures content');
    }
    if (verdict.referencedWeekday !== 'none' && verdict.referencedWeekday !== expectedWeekday) {
      throw new IngestValidationError(
        `llm verification: transcript references ${verdict.referencedWeekday} but ${expected.date} is a ${expectedWeekday}`,
      );
    }
    if (verdict.confidence === 'low') {
      throw new IngestValidationError('llm verification: low-confidence classification');
    }
    return verdict; // recorded as manifest evidence
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/eminiplayer backend/src/config backend/.env.example
git commit -m "feat(eminiplayer): blocking LLM transcript verification via the LLM_PROVIDER seam"
```

---

### Task 5: EminiplayerManifestService (manifest + video-id uniqueness)

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-manifest.service.ts`
- Test: `backend/src/eminiplayer/eminiplayer-manifest.service.spec.ts`

**Interfaces:**
- Consumes: `STORAGE_BUCKET`, `FIRESTORE` tokens (`backend/src/firebase/firebase.constants`); `IngestValidationError` (Task 3); `manifestPath` (Task 3); `INGEST_PIPELINE_VERSION` (Task 2); `TranscriptVerdict` (Task 4).
- Produces (used by Tasks 6–8):
  - `interface FileRecord { storagePath: string; sha256: string; md5: string; bytes: number }` (`md5` is base64, comparable to GCS object metadata's `md5Hash`)
  - `interface DayManifest { version: number; date: string; recapDate: string; createdAt: string; sources: { recapPageUrl: string; tradePlanPageUrl: string; recapVideoId: string; tradePlanVideoId: string }; files: { recap: FileRecord; tradePlanMd: FileRecord; tradePlanPdf: FileRecord }; evidence: { recapVideoTitle: string; tradePlanVideoTitle: string; recapVerdict: TranscriptVerdict; tradePlanVerdict: TranscriptVerdict } }` — evidence, not booleans: a questioned day can be re-examined without re-scraping
  - `const VIDEO_IDS_COLLECTION = 'eminiplayer-video-ids'`
  - `EminiplayerManifestService`: `path(date): string` (delegates to Task 3's `manifestPath`), `exists(date): Promise<boolean>`, `read(date): Promise<DayManifest | null>`, `delete(date): Promise<void>` (**releases the day's video-id claims first** — symmetric uncommit, so a force-rerun resolving different videos never leaves stale claims that 422-block a neighboring day), `commit(manifest: DayManifest): Promise<void>` (claims both video ids transactionally, then writes the manifest — the last step of a run; a claim held by a different `{date, slot}` throws `IngestValidationError`).

- [ ] **Step 1: Write the failing tests**

`backend/src/eminiplayer/eminiplayer-manifest.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { STORAGE_BUCKET, FIRESTORE } from '../firebase/firebase.constants';
import {
  DayManifest,
  EminiplayerManifestService,
  VIDEO_IDS_COLLECTION,
} from './eminiplayer-manifest.service';
import { IngestValidationError } from './eminiplayer-ingest.errors';
import type { TranscriptVerdict } from './eminiplayer-verify.service';

const VERDICT: TranscriptVerdict = {
  docType: 'recap',
  isEsContent: true,
  referencedWeekday: 'Tuesday',
  confidence: 'high',
};

const MANIFEST: DayManifest = {
  version: 1,
  date: '07012026',
  recapDate: '06302026',
  createdAt: '2026-07-01T13:00:00.000Z',
  sources: {
    recapPageUrl: 'https://www.eminiplayer.net/post/recap.aspx',
    tradePlanPageUrl: 'https://www.eminiplayer.net/post/tp.aspx',
    recapVideoId: 'recapVid0001',
    tradePlanVideoId: 'tpVid0000001',
  },
  files: {
    recap: { storagePath: 'knowledge-base/es/07012026/06302026_ES_RECAP.md', sha256: 'a'.repeat(64), md5: 'aaa=', bytes: 1000 },
    tradePlanMd: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.md', sha256: 'b'.repeat(64), md5: 'bbb=', bytes: 1100 },
    tradePlanPdf: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.pdf', sha256: 'c'.repeat(64), md5: 'ccc=', bytes: 50000 },
  },
  evidence: {
    recapVideoTitle: 'ES Recap/Video Lesson for Tuesday 06/30/2026',
    tradePlanVideoTitle: 'ES Key Zones and Trade Plan for Wednesday 07/01/2026',
    recapVerdict: VERDICT,
    tradePlanVerdict: { ...VERDICT, docType: 'tradePlan', referencedWeekday: 'Wednesday' },
  },
};

function makeFakes(
  claims: Record<string, { date: string; slot: string }> = {},
  storedManifest: DayManifest | null = null,
) {
  const file = {
    exists: jest.fn(() => Promise.resolve([storedManifest !== null])),
    save: jest.fn(() => Promise.resolve()),
    delete: jest.fn(() => Promise.resolve()),
    download: jest.fn(() =>
      Promise.resolve([Buffer.from(JSON.stringify(storedManifest ?? {}))]),
    ),
  };
  const bucket = { file: jest.fn(() => file) };
  const docRefs = new Map<string, { id: string }>();
  const txSets: Array<[string, unknown]> = [];
  const txDeletes: string[] = [];
  const firestore = {
    collection: jest.fn(() => ({
      doc: jest.fn((id: string) => {
        if (!docRefs.has(id)) docRefs.set(id, { id });
        return docRefs.get(id);
      }),
    })),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: jest.fn((ref: { id: string }) =>
          Promise.resolve(
            claims[ref.id]
              ? { exists: true, data: () => claims[ref.id] }
              : { exists: false, data: () => undefined },
          ),
        ),
        set: jest.fn((ref: { id: string }, data: unknown) => {
          txSets.push([ref.id, data]);
        }),
        delete: jest.fn((ref: { id: string }) => {
          txDeletes.push(ref.id);
        }),
      };
      await fn(tx);
    }),
  };
  return { bucket, file, firestore, txSets, txDeletes };
}

async function build(fakes = makeFakes()) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerManifestService,
      { provide: STORAGE_BUCKET, useValue: fakes.bucket },
      { provide: FIRESTORE, useValue: fakes.firestore },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerManifestService), ...fakes };
}

describe('EminiplayerManifestService', () => {
  it('computes the manifest path', async () => {
    const { service } = await build();
    expect(service.path('07012026')).toBe('knowledge-base/es/07012026/manifest.json');
  });

  it('commit claims both video ids then writes the manifest', async () => {
    const { service, bucket, file, txSets, firestore } = await build();
    await service.commit(MANIFEST);
    expect(firestore.collection).toHaveBeenCalledWith(VIDEO_IDS_COLLECTION);
    expect(txSets.map(([id]) => id)).toEqual(['recapVid0001', 'tpVid0000001']);
    expect(bucket.file).toHaveBeenCalledWith('knowledge-base/es/07012026/manifest.json');
    const [payload, opts] = file.save.mock.calls[0];
    expect(JSON.parse(payload)).toEqual(MANIFEST);
    expect(opts).toEqual({ contentType: 'application/json' });
    // claims happen BEFORE the manifest write
    expect(firestore.runTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      file.save.mock.invocationCallOrder[0],
    );
  });

  it('re-claim by the same date+slot is idempotent', async () => {
    const fakes = makeFakes({ recapVid0001: { date: '07012026', slot: 'recap' } });
    const { service, file } = await build(fakes);
    await service.commit(MANIFEST);
    expect(file.save).toHaveBeenCalled();
  });

  it('a claim held by another day throws IngestValidationError and never writes the manifest', async () => {
    const fakes = makeFakes({ recapVid0001: { date: '06152026', slot: 'recap' } });
    const { service, file } = await build(fakes);
    await expect(service.commit(MANIFEST)).rejects.toThrow(IngestValidationError);
    expect(file.save).not.toHaveBeenCalled();
  });

  it('read parses the stored manifest, or returns null when absent', async () => {
    const { service: withManifest } = await build(makeFakes({}, MANIFEST));
    await expect(withManifest.read('07012026')).resolves.toEqual(MANIFEST);
    const { service: without } = await build(makeFakes({}, null));
    await expect(without.read('07012026')).resolves.toBeNull();
  });

  it('delete releases the day-owned claims BEFORE removing the manifest (symmetric uncommit)', async () => {
    const fakes = makeFakes(
      {
        recapVid0001: { date: '07012026', slot: 'recap' },
        tpVid0000001: { date: '07012026', slot: 'tradePlan' },
      },
      MANIFEST,
    );
    const { service, file, txDeletes } = await build(fakes);
    await service.delete('07012026');
    expect(txDeletes.sort()).toEqual(['recapVid0001', 'tpVid0000001']);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('delete never touches a claim owned by a different date', async () => {
    // the manifest names recapVid0001, but another day now owns that claim
    const fakes = makeFakes({ recapVid0001: { date: '07152026', slot: 'recap' } }, MANIFEST);
    const { service, txDeletes, file } = await build(fakes);
    await service.delete('07012026');
    expect(txDeletes).toEqual([]);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('delete with no stored manifest just removes the (absent) file', async () => {
    const fakes = makeFakes({}, null);
    const { service, txDeletes, file } = await build(fakes);
    await service.delete('07012026');
    expect(txDeletes).toEqual([]);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('exists reflects the bucket', async () => {
    const fakes = makeFakes({}, MANIFEST);
    const { service } = await build(fakes);
    await expect(service.exists('07012026')).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-manifest`
Expected: FAIL — cannot find module `./eminiplayer-manifest.service`.

- [ ] **Step 3: Write the implementation**

`backend/src/eminiplayer/eminiplayer-manifest.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Bucket } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { IngestValidationError } from './eminiplayer-ingest.errors';
import { manifestPath } from './eminiplayer-validation';
import type { TranscriptVerdict } from './eminiplayer-verify.service';

export interface FileRecord {
  storagePath: string;
  sha256: string;
  /** base64 — comparable against GCS object metadata's `md5Hash`. */
  md5: string;
  bytes: number;
}

export interface DayManifest {
  version: number;
  date: string;
  recapDate: string;
  createdAt: string;
  sources: {
    recapPageUrl: string;
    tradePlanPageUrl: string;
    recapVideoId: string;
    tradePlanVideoId: string;
  };
  files: {
    recap: FileRecord;
    tradePlanMd: FileRecord;
    tradePlanPdf: FileRecord;
  };
  /**
   * Verification evidence, not booleans: a manifest can only exist if every
   * check passed, so what matters for a later-questioned day is WHAT the
   * checks saw — the video titles and the LLM verdicts.
   */
  evidence: {
    recapVideoTitle: string;
    tradePlanVideoTitle: string;
    recapVerdict: TranscriptVerdict;
    tradePlanVerdict: TranscriptVerdict;
  };
}

export const VIDEO_IDS_COLLECTION = 'eminiplayer-video-ids';

/**
 * The manifest is the day group's commit record and the consumers' trust
 * gate: written last, only after every check passed. The Firestore video-id
 * collection guarantees the same YouTube video can never serve two day
 * groups (wrong-entry selection across days shows up here as a conflict).
 * Uncommit (delete) is symmetric with commit: it releases the day's claims
 * before removing the manifest, so a force-rerun that resolves different
 * videos can never leave stale claims 422-blocking a neighboring day.
 */
@Injectable()
export class EminiplayerManifestService {
  constructor(
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
    @Inject(FIRESTORE) private readonly firestore: Firestore,
  ) {}

  path(date: string): string {
    return manifestPath(date);
  }

  async exists(date: string): Promise<boolean> {
    const [exists] = await this.bucket.file(this.path(date)).exists();
    return exists;
  }

  /** Parsed manifest, or null when the day is uncommitted. */
  async read(date: string): Promise<DayManifest | null> {
    const file = this.bucket.file(this.path(date));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return JSON.parse(buf.toString('utf8')) as DayManifest;
  }

  /**
   * Uncommit a day (force-regeneration) — artifacts stay, trust is revoked,
   * and the day's video-id claims are released FIRST so they can't outlive
   * the manifest that justified them.
   */
  async delete(date: string): Promise<void> {
    const manifest = await this.read(date).catch(() => null); // unreadable: still remove; audit flags orphans
    if (manifest) {
      await this.release(manifest.sources.recapVideoId, date);
      await this.release(manifest.sources.tradePlanVideoId, date);
    }
    await this.bucket.file(this.path(date)).delete({ ignoreNotFound: true });
  }

  /** Claims both video ids, then writes the manifest — the LAST step of a run. */
  async commit(manifest: DayManifest): Promise<void> {
    await this.claim(manifest.sources.recapVideoId, manifest.date, 'recap');
    await this.claim(manifest.sources.tradePlanVideoId, manifest.date, 'tradePlan');
    await this.bucket
      .file(this.path(manifest.date))
      .save(JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
  }

  private async claim(videoId: string, date: string, slot: 'recap' | 'tradePlan'): Promise<void> {
    const ref = this.firestore.collection(VIDEO_IDS_COLLECTION).doc(videoId);
    await this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const owner = snap.data() as { date: string; slot: string };
        if (owner.date === date && owner.slot === slot) return; // idempotent re-claim
        throw new IngestValidationError(
          `video ${videoId} is already claimed by ${owner.date}/${owner.slot} — the same video cannot serve two day groups`,
        );
      }
      tx.set(ref, { date, slot, claimedAt: new Date().toISOString() });
    });
  }

  /** Deletes the claim only when this date owns it — never a foreign claim. */
  private async release(videoId: string, date: string): Promise<void> {
    const ref = this.firestore.collection(VIDEO_IDS_COLLECTION).doc(videoId);
    await this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { date: string }).date === date) {
        tx.delete(ref);
      }
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-manifest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/eminiplayer
git commit -m "feat(eminiplayer): manifest commit service with transactional video-id uniqueness"
```

---

### Task 6: EminiplayerIngestService (orchestrator)

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-ingest.service.ts`
- Test: `backend/src/eminiplayer/eminiplayer-ingest.service.spec.ts`
- Modify: `backend/src/eminiplayer/eminiplayer.module.ts` (import TranscriptModule, provide + export services)

**Interfaces:**
- Consumes:
  - `EminiplayerService.findDayEntries(date) → Promise<DayEntries>` / `.getYoutubeUrl(pageUrl) → Promise<string>` / `.downloadTradePlanPdf(pageUrl) → Promise<Buffer>` (Task 2)
  - `TranscriptService.fetchSegments(urlOrId)` / `.fetchVideoTitle(videoId)` + `transcriptToMarkdown` (Task 1)
  - Validation functions + errors (Task 3)
  - `EminiplayerVerifyService.verifyTranscript(markdown, {flavor, date})` (Task 4)
  - `EminiplayerManifestService` + `DayManifest`/`FileRecord` (Task 5)
  - `STORAGE_BUCKET` (`bucket.file(path).exists()/download()/save()`, `bucket.getFiles({prefix})`), `INGEST_PIPELINE_VERSION` (Task 2)
- Produces (used by Task 7):
  - `interface IngestFileReport { storagePath: string; status: 'uploaded' | 'skipped' }`
  - `interface IngestResult { date: string; recapDate: string; staleRecapsRemoved: string[]; manifestPath: string; files: { recap: IngestFileReport; tradePlanMd: IngestFileReport; tradePlanPdf: IngestFileReport } }`
  - `EminiplayerIngestService.ingest(date: string, force?: boolean): Promise<IngestResult>` — concurrent same-date calls coalesce, except a `force=true` call finding a non-force run in flight waits it out and then runs the forced pass (force is never silently dropped); `ArchiveNotFoundError` and `IngestValidationError` pass through untouched. Short-circuit responses are built from the manifest (via `manifest.read`), and a committed recapDate differing from the fresh resolution throws `IngestValidationError`.

- [ ] **Step 1: Write the failing tests**

`backend/src/eminiplayer/eminiplayer-ingest.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import { EminiplayerService } from './eminiplayer.service';
import { TranscriptService } from '../transcript/transcript.service';
import { EminiplayerVerifyService } from './eminiplayer-verify.service';
import { EminiplayerManifestService } from './eminiplayer-manifest.service';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError, type DayEntries } from './eminiplayer.constants';
import { VideoUnavailableError } from '../transcript/transcript.service';

const DATE = '07012026'; // Wednesday
const RECAP_DATE = '06302026'; // Tuesday
const DIR = `knowledge-base/es/${DATE}`;
const RECAP_PATH = `${DIR}/${RECAP_DATE}_ES_RECAP.md`;
const TP_MD_PATH = `${DIR}/${DATE}_ES_TP.md`;
const TP_PDF_PATH = `${DIR}/${DATE}_ES_TP.pdf`;
const MANIFEST_PATH = `${DIR}/manifest.json`;

const ENTRIES: DayEntries = {
  tradePlan: {
    date: DATE,
    pageUrl: 'https://www.eminiplayer.net/post/tp.aspx',
    title: 'ES Key Zones and Trade Plan for Wed. 07/01/2026',
  },
  recap: {
    date: RECAP_DATE,
    pageUrl: 'https://www.eminiplayer.net/post/recap.aspx',
    title: 'ES Recap/Video Lesson for Tuesday 06/30/2026',
  },
};

/** 60 lines, 4s apart — passes the transcript gate. */
function plausibleMarkdown(label: string): string {
  const rows: string[] = [];
  for (let i = 0; i < 60; i++) {
    const t = i * 4;
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    rows.push(`**${mm}:${ss}** ${label} segment ${i} with enough words to count`);
  }
  return `# Transcript\n\n${rows.join('\n')}\n`;
}

function plausibleSegments(label: string) {
  return Array.from({ length: 60 }, (_, i) => ({
    text: `${label} segment ${i} with enough words to count`,
    offset: i * 4,
  }));
}

function plausiblePdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'),
    Buffer.alloc(12000, 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);
}

type FakeFile = {
  name: string;
  exists: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
  download: jest.Mock;
};

function makeBucket(existing: Record<string, string | Buffer> = {}) {
  const files = new Map<string, FakeFile>();
  const get = (path: string): FakeFile => {
    if (!files.has(path)) {
      files.set(path, {
        name: path,
        exists: jest.fn(() => Promise.resolve([existing[path] !== undefined])),
        save: jest.fn(() => Promise.resolve()),
        delete: jest.fn(() => Promise.resolve()),
        download: jest.fn(() =>
          Promise.resolve([
            Buffer.isBuffer(existing[path]) ? existing[path] : Buffer.from(String(existing[path] ?? '')),
          ]),
        ),
      });
    }
    return files.get(path)!;
  };
  return {
    files,
    file: jest.fn(get),
    getFiles: jest.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve([
        Object.keys(existing)
          .filter((p) => p.startsWith(prefix))
          .map(get),
      ]),
    ),
  };
}

/** A minimal committed manifest for short-circuit tests. */
function committedManifest(recapDate = RECAP_DATE) {
  const dir = `knowledge-base/es/${DATE}`;
  return {
    version: 1,
    date: DATE,
    recapDate,
    createdAt: '2026-07-01T13:00:00.000Z',
    sources: {
      recapPageUrl: ENTRIES.recap.pageUrl,
      tradePlanPageUrl: ENTRIES.tradePlan.pageUrl,
      recapVideoId: 'recapVid0001',
      tradePlanVideoId: 'tpVid0000001',
    },
    files: {
      recap: { storagePath: `${dir}/${recapDate}_ES_RECAP.md`, sha256: 'a'.repeat(64), md5: 'a=', bytes: 1 },
      tradePlanMd: { storagePath: TP_MD_PATH, sha256: 'b'.repeat(64), md5: 'b=', bytes: 1 },
      tradePlanPdf: { storagePath: TP_PDF_PATH, sha256: 'c'.repeat(64), md5: 'c=', bytes: 1 },
    },
    evidence: {
      recapVideoTitle: 'x', tradePlanVideoTitle: 'y',
      recapVerdict: { docType: 'recap', isEsContent: true, referencedWeekday: 'none', confidence: 'high' },
      tradePlanVerdict: { docType: 'tradePlan', isEsContent: true, referencedWeekday: 'none', confidence: 'high' },
    },
  };
}

async function build({
  bucket = makeBucket(),
  entries = ENTRIES,
  committed = null as ReturnType<typeof committedManifest> | null,
}: {
  bucket?: ReturnType<typeof makeBucket>;
  entries?: DayEntries;
  committed?: ReturnType<typeof committedManifest> | null;
} = {}) {
  const eminiplayer = {
    findDayEntries: jest.fn(() => Promise.resolve(entries)),
    getYoutubeUrl: jest.fn((pageUrl: string) =>
      Promise.resolve(
        pageUrl.includes('recap')
          ? 'https://youtu.be/recapVid0001'
          : 'https://youtu.be/tpVid0000001',
      ),
    ),
    downloadTradePlanPdf: jest.fn(() => Promise.resolve(plausiblePdf())),
  };
  const transcript = {
    fetchSegments: jest.fn((url: string) =>
      Promise.resolve(plausibleSegments(url.includes('recap') ? 'recap' : 'tp')),
    ),
    fetchVideoTitle: jest.fn((videoId: string) =>
      Promise.resolve(
        videoId === 'recapVid0001'
          ? 'ES Recap/Video Lesson for Tuesday 06/30/2026'
          : 'ES Key Zones and Trade Plan for Wed. 07/01/2026',
      ),
    ),
  };
  const verify = {
    verifyTranscript: jest.fn((_md: string, expected: { flavor: string }) =>
      Promise.resolve({
        docType: expected.flavor,
        isEsContent: true,
        referencedWeekday: 'none',
        confidence: 'high',
      }),
    ),
  };
  const manifest = {
    path: jest.fn((date: string) => `knowledge-base/es/${date}/manifest.json`),
    read: jest.fn(() => Promise.resolve(committed)),
    exists: jest.fn(() => Promise.resolve(committed !== null)),
    delete: jest.fn(() => Promise.resolve()),
    commit: jest.fn(() => Promise.resolve()),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerIngestService,
      { provide: EminiplayerService, useValue: eminiplayer },
      { provide: TranscriptService, useValue: transcript },
      { provide: EminiplayerVerifyService, useValue: verify },
      { provide: EminiplayerManifestService, useValue: manifest },
      { provide: STORAGE_BUCKET, useValue: bucket },
    ],
  }).compile();
  return {
    service: moduleRef.get(EminiplayerIngestService),
    eminiplayer,
    transcript,
    verify,
    manifest,
    bucket,
  };
}

describe('EminiplayerIngestService.ingest', () => {
  it('produces, verifies, uploads all three artifacts and commits a manifest', async () => {
    const { service, bucket, verify, manifest } = await build();
    const result = await service.ingest(DATE);

    expect(result).toEqual({
      date: DATE,
      recapDate: RECAP_DATE,
      staleRecapsRemoved: [],
      manifestPath: MANIFEST_PATH,
      files: {
        recap: { storagePath: RECAP_PATH, status: 'uploaded' },
        tradePlanMd: { storagePath: TP_MD_PATH, status: 'uploaded' },
        tradePlanPdf: { storagePath: TP_PDF_PATH, status: 'uploaded' },
      },
    });

    expect(bucket.files.get(RECAP_PATH)!.save).toHaveBeenCalledWith(
      expect.stringContaining('# Transcript'),
      { contentType: 'text/markdown' },
    );
    expect(bucket.files.get(TP_PDF_PATH)!.save).toHaveBeenCalledWith(
      expect.any(Buffer),
      { contentType: 'application/pdf' },
    );
    expect(verify.verifyTranscript).toHaveBeenCalledTimes(2);
    expect(verify.verifyTranscript).toHaveBeenCalledWith(expect.any(String), {
      flavor: 'recap',
      date: RECAP_DATE,
    });
    expect(verify.verifyTranscript).toHaveBeenCalledWith(expect.any(String), {
      flavor: 'tradePlan',
      date: DATE,
    });

    const written = manifest.commit.mock.calls[0][0];
    expect(written.date).toBe(DATE);
    expect(written.sources.recapVideoId).toBe('recapVid0001');
    expect(written.sources.tradePlanVideoId).toBe('tpVid0000001');
    expect(written.files.recap.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.files.recap.md5).toMatch(/=$/); // base64
    // evidence recorded, not booleans: titles + verdicts
    expect(written.evidence.recapVideoTitle).toContain('Recap');
    expect(written.evidence.tradePlanVideoTitle).toContain('Trade Plan');
    expect(written.evidence.recapVerdict.docType).toBe('recap');
    expect(written.evidence.tradePlanVerdict.docType).toBe('tradePlan');
  });

  it('manifest short-circuit: committed day + matching recapDate reports all-skipped from the MANIFEST paths', async () => {
    const { service, eminiplayer, transcript } = await build({ committed: committedManifest() });
    const result = await service.ingest(DATE);
    expect(result.recapDate).toBe(RECAP_DATE); // from the manifest
    expect(result.files.recap).toEqual({ storagePath: RECAP_PATH, status: 'skipped' });
    expect(result.files.tradePlanMd.status).toBe('skipped');
    expect(result.files.tradePlanPdf.status).toBe('skipped');
    expect(eminiplayer.findDayEntries).toHaveBeenCalled(); // resolve still runs
    expect(eminiplayer.getYoutubeUrl).not.toHaveBeenCalled();
    expect(transcript.fetchSegments).not.toHaveBeenCalled();
  });

  it('manifest short-circuit: committed recap STALER than the fresh resolution → 422, never silent success', async () => {
    // day committed early with 06/29's recap; the archive now resolves 06/30
    const { service, manifest } = await build({ committed: committedManifest('06292026') });
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestValidationError);
    expect(err.message).toContain('06292026');
    expect(err.message).toContain('force');
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('unmanifested existing artifacts are reloaded and fully re-verified (skip production, never verification)', async () => {
    const bucket = makeBucket({
      [RECAP_PATH]: plausibleMarkdown('recap'),
      [TP_PDF_PATH]: plausiblePdf(),
    });
    const { service, transcript, verify, manifest } = await build({ bucket });
    const result = await service.ingest(DATE);

    expect(result.files.recap.status).toBe('skipped');
    expect(result.files.tradePlanMd.status).toBe('uploaded');
    expect(result.files.tradePlanPdf.status).toBe('skipped');
    // recap transcription skipped, but its verification still ran
    expect(transcript.fetchSegments).toHaveBeenCalledTimes(1);
    expect(verify.verifyTranscript).toHaveBeenCalledTimes(2);
    expect(manifest.commit).toHaveBeenCalled();
  });

  it('force=true deletes the manifest first and regenerates everything', async () => {
    const bucket = makeBucket({
      [RECAP_PATH]: plausibleMarkdown('recap'),
      [TP_MD_PATH]: plausibleMarkdown('tp'),
      [TP_PDF_PATH]: plausiblePdf(),
    });
    const { service, manifest } = await build({ bucket, committed: committedManifest() });
    const result = await service.ingest(DATE, true);
    expect(manifest.delete).toHaveBeenCalledWith(DATE);
    expect(result.files.recap.status).toBe('uploaded');
    expect(result.files.tradePlanMd.status).toBe('uploaded');
    expect(result.files.tradePlanPdf.status).toBe('uploaded');
  });

  it('removes stale recap files, never the currently-resolved one', async () => {
    // resumed run: both the stale recap AND the current recap are present —
    // the exclusion filter must delete exactly one of them
    const stalePath = `${DIR}/06292026_ES_RECAP.md`;
    const bucket = makeBucket({
      [stalePath]: plausibleMarkdown('stale'),
      [RECAP_PATH]: plausibleMarkdown('recap'),
    });
    const { service, verify } = await build({ bucket });
    const result = await service.ingest(DATE);
    expect(result.staleRecapsRemoved).toEqual([stalePath]);
    expect(bucket.files.get(stalePath)!.delete).toHaveBeenCalled();
    expect(bucket.files.get(RECAP_PATH)!.delete).not.toHaveBeenCalled();
    expect(result.files.recap.status).toBe('skipped'); // reloaded, not re-produced
    expect(verify.verifyTranscript).toHaveBeenCalledTimes(2); // still verified
  });

  it('propagates ArchiveNotFoundError untouched (404 path)', async () => {
    const { service, eminiplayer } = await build();
    eminiplayer.findDayEntries.mockRejectedValue(new ArchiveNotFoundError('no TP entry'));
    await expect(service.ingest(DATE)).rejects.toThrow(ArchiveNotFoundError);
  });

  it('propagates IngestValidationError untouched and never commits (422 path)', async () => {
    const { service, transcript, manifest } = await build();
    // wrong-flavor video title in the recap slot
    transcript.fetchVideoTitle.mockResolvedValue(
      'ES Key Zones and Trade Plan for Wed. 07/01/2026',
    );
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('a failing transcript gate blocks upload and commit', async () => {
    const { service, transcript, manifest, bucket } = await build();
    transcript.fetchSegments.mockResolvedValue([{ text: 'too short', offset: 0 }]);
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    // the file HANDLE exists (the exists-check needs it before the gate runs);
    // what must never have happened is the save
    expect(bucket.files.get(RECAP_PATH)!.save).not.toHaveBeenCalled();
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('an unavailable video (oEmbed 4xx) is a 422, not a retryable stage error', async () => {
    const { service, transcript, manifest } = await build();
    transcript.fetchVideoTitle.mockRejectedValue(new VideoUnavailableError('HTTP 404'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestValidationError);
    expect(err.message).toContain('unavailable');
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('an LLM verdict mismatch blocks commit; artifacts remain', async () => {
    const { service, verify, manifest, bucket } = await build();
    verify.verifyTranscript.mockRejectedValue(new IngestValidationError('llm verification: nope'));
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    expect(bucket.files.get(RECAP_PATH)!.save).toHaveBeenCalled(); // uploaded before verify
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('wraps a resolve failure as IngestStageError(resolve, archive)', async () => {
    const { service, eminiplayer } = await build();
    eminiplayer.findDayEntries.mockRejectedValue(new Error('selectors not implemented yet'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.stage).toBe('resolve');
    expect(err.artifact).toBe('archive');
  });

  it('wraps an LLM transport failure as IngestStageError(verify, <artifact>)', async () => {
    const { service, verify } = await build();
    verify.verifyTranscript.mockRejectedValueOnce(new Error('api down'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.stage).toBe('verify');
    expect(err.artifact).toBe('recap');
  });

  it('a mid-run failure preserves earlier uploads (resume semantics)', async () => {
    const { service, eminiplayer, bucket } = await build();
    eminiplayer.getYoutubeUrl
      .mockImplementationOnce(() => Promise.resolve('https://youtu.be/recapVid0001'))
      .mockImplementationOnce(() => Promise.reject(new Error('tp page broke')));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.artifact).toBe('tradePlanMd');
    expect(bucket.files.get(RECAP_PATH)!.save).toHaveBeenCalled();
    expect(bucket.files.get(TP_PDF_PATH)?.save).toBeUndefined();
  });

  it('coalesces concurrent ingests for the same date onto one run', async () => {
    const { service, eminiplayer } = await build();
    const [a, b] = await Promise.all([service.ingest(DATE), service.ingest(DATE)]);
    expect(a).toBe(b);
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(1);
    await service.ingest(DATE);
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(2);
  });

  it('force is never silently dropped: queued behind an in-flight non-force run, then actually runs', async () => {
    const { service, eminiplayer, manifest } = await build();
    const [normal, forced] = await Promise.all([
      service.ingest(DATE), // non-force run in flight...
      service.ingest(DATE, true), // ...force arrives, must not coalesce away
    ]);
    expect(normal).toBeDefined();
    expect(forced).toBeDefined();
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(2); // both runs happened
    expect(manifest.delete).toHaveBeenCalledWith(DATE); // the forced pass ran force semantics
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-ingest.service`
Expected: FAIL — cannot find module `./eminiplayer-ingest.service`.

- [ ] **Step 3: Write the implementation**

`backend/src/eminiplayer/eminiplayer-ingest.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Bucket } from '@google-cloud/storage';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import {
  TranscriptService,
  VideoUnavailableError,
  transcriptToMarkdown,
} from '../transcript/transcript.service';
import { EminiplayerService } from './eminiplayer.service';
import {
  ArchiveEntry,
  ArchiveNotFoundError,
  INGEST_PIPELINE_VERSION,
} from './eminiplayer.constants';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import {
  assertDayInvariants,
  assertPdfBuffer,
  assertTranscriptMarkdown,
  assertVideoTitle,
  dayPaths,
  extractYoutubeVideoId,
  md5Base64,
  sha256Hex,
  VideoFlavor,
} from './eminiplayer-validation';
import { EminiplayerVerifyService, TranscriptVerdict } from './eminiplayer-verify.service';
import {
  DayManifest,
  EminiplayerManifestService,
  FileRecord,
} from './eminiplayer-manifest.service';

export interface IngestFileReport {
  storagePath: string;
  status: 'uploaded' | 'skipped';
}

export interface IngestResult {
  date: string;
  recapDate: string;
  /** Old *_ES_RECAP.md objects deleted because their date no longer matches. */
  staleRecapsRemoved: string[];
  manifestPath: string;
  files: {
    recap: IngestFileReport;
    tradePlanMd: IngestFileReport;
    tradePlanPdf: IngestFileReport;
  };
}

type Artifact = 'recap' | 'tradePlanMd' | 'tradePlanPdf';
type Stage = 'plan' | 'resolve' | 'transcribe' | 'download' | 'verify' | 'upload' | 'commit';

interface ProducedTranscript {
  report: IngestFileReport;
  videoId: string;
  title: string;
  verdict: TranscriptVerdict;
  record: FileRecord;
}

/**
 * Orchestrates one day's document group: resolve archive entries, gate and
 * cross-check everything (see the spec's verification decision), transcribe
 * the two videos, download the TP pdf, upload each artifact as soon as it is
 * produced, LLM-verify both transcripts, and only then commit the day via its
 * manifest. Skip skips production, never verification — a resumed run reloads
 * existing artifacts and re-verifies them, because the previous run may have
 * died between upload and verify. Concurrent requests for the same date
 * coalesce onto one in-flight run.
 */
@Injectable()
export class EminiplayerIngestService {
  private readonly logger = new Logger(EminiplayerIngestService.name);
  private readonly inflight = new Map<string, { force: boolean; run: Promise<IngestResult> }>();

  constructor(
    private readonly eminiplayer: EminiplayerService,
    private readonly transcript: TranscriptService,
    private readonly verify: EminiplayerVerifyService,
    private readonly manifest: EminiplayerManifestService,
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
  ) {}

  async ingest(date: string, force = false): Promise<IngestResult> {
    const existing = this.inflight.get(date);
    if (existing) {
      // Coalesce same-flag calls (and non-force onto anything). A force call
      // finding a NON-force run must not be silently dropped: wait the
      // in-flight run out, then run the forced regeneration.
      if (!force || existing.force) return existing.run;
      await existing.run.catch(() => undefined);
      return this.ingest(date, true);
    }
    const run = this.run(date, force).finally(() => this.inflight.delete(date));
    this.inflight.set(date, { force, run });
    return run;
  }

  private async run(date: string, force: boolean): Promise<IngestResult> {
    // Resolution always runs: the recap filename embeds the recap date,
    // which only the archive listing knows.
    const entries = await this.stage('resolve', 'archive', () =>
      this.eminiplayer.findDayEntries(date),
    );
    const recapDate = entries.recap.date;
    assertDayInvariants(date, recapDate);

    const paths = dayPaths(date, recapDate);

    if (force) {
      // Revoke trust before touching files (releases the day's video-id
      // claims too — see EminiplayerManifestService.delete). The day is
      // uncommitted while regeneration runs.
      await this.stage('plan', 'archive', () => this.manifest.delete(date));
    } else {
      const committed = await this.stage('plan', 'archive', () => this.manifest.read(date));
      if (committed) {
        // Committed day. The response must come from the MANIFEST (the fresh
        // resolve may reference paths that don't exist in the bucket), and a
        // recapDate drift means the day was committed before the real recap
        // was posted — frozen wrong data unless we refuse here.
        if (committed.recapDate !== recapDate) {
          throw new IngestValidationError(
            `committed manifest for ${date} references recap ${committed.recapDate} but the archive now resolves ${recapDate} — the committed recap is stale; rerun with force=true to regenerate`,
          );
        }
        return {
          date,
          recapDate: committed.recapDate,
          staleRecapsRemoved: [],
          manifestPath: paths.manifest,
          files: {
            recap: { storagePath: committed.files.recap.storagePath, status: 'skipped' },
            tradePlanMd: { storagePath: committed.files.tradePlanMd.storagePath, status: 'skipped' },
            tradePlanPdf: { storagePath: committed.files.tradePlanPdf.storagePath, status: 'skipped' },
          },
        };
      }
    }

    const staleRecapsRemoved = await this.removeStaleRecaps(paths.dir, paths.recap);

    const recap = await this.produceTranscript('recap', paths.recap, force, entries.recap, recapDate);
    const tradePlanMd = await this.produceTranscript(
      'tradePlanMd',
      paths.tradePlanMd,
      force,
      entries.tradePlan,
      date,
    );
    const tradePlanPdf = await this.producePdf(paths.tradePlanPdf, force, entries.tradePlan);

    const dayManifest: DayManifest = {
      version: INGEST_PIPELINE_VERSION,
      date,
      recapDate,
      createdAt: new Date().toISOString(),
      sources: {
        recapPageUrl: entries.recap.pageUrl,
        tradePlanPageUrl: entries.tradePlan.pageUrl,
        recapVideoId: recap.videoId,
        tradePlanVideoId: tradePlanMd.videoId,
      },
      files: {
        recap: recap.record,
        tradePlanMd: tradePlanMd.record,
        tradePlanPdf: tradePlanPdf.record,
      },
      evidence: {
        recapVideoTitle: recap.title,
        tradePlanVideoTitle: tradePlanMd.title,
        recapVerdict: recap.verdict,
        tradePlanVerdict: tradePlanMd.verdict,
      },
    };
    await this.stage('commit', 'archive', () => this.manifest.commit(dayManifest));
    this.logger.log(`committed ${paths.manifest}`);

    return {
      date,
      recapDate,
      staleRecapsRemoved,
      manifestPath: paths.manifest,
      files: {
        recap: recap.report,
        tradePlanMd: tradePlanMd.report,
        tradePlanPdf: tradePlanPdf.report,
      },
    };
  }

  private flavorOf(artifact: Artifact): VideoFlavor {
    return artifact === 'recap' ? 'recap' : 'tradePlan';
  }

  private async produceTranscript(
    artifact: 'recap' | 'tradePlanMd',
    storagePath: string,
    force: boolean,
    entry: ArchiveEntry,
    expectedDate: string,
  ): Promise<ProducedTranscript> {
    const flavor = this.flavorOf(artifact);
    const youtubeUrl = await this.stage('resolve', artifact, () =>
      this.eminiplayer.getYoutubeUrl(entry.pageUrl),
    );
    const videoId = extractYoutubeVideoId(youtubeUrl);
    let title: string;
    try {
      title = await this.transcript.fetchVideoTitle(videoId);
    } catch (err) {
      // A deleted/private video is a permanent data condition (422, human
      // must look), not a retryable transport failure.
      if (err instanceof VideoUnavailableError) {
        throw new IngestValidationError(
          `${artifact} video ${videoId} is unavailable on YouTube: ${err.message}`,
        );
      }
      throw new IngestStageError('verify', artifact, err as Error);
    }
    assertVideoTitle(title, expectedDate, flavor);

    const file = this.bucket.file(storagePath);
    let markdown: string;
    let status: 'uploaded' | 'skipped';
    const [exists] = force
      ? [false]
      : await this.stage('plan', artifact, () => file.exists());
    if (exists) {
      const [buf] = await this.stage('plan', artifact, () => file.download());
      markdown = buf.toString('utf8');
      assertTranscriptMarkdown(markdown, artifact);
      status = 'skipped';
    } else {
      const segments = await this.stage('transcribe', artifact, () =>
        this.transcript.fetchSegments(youtubeUrl),
      );
      markdown = transcriptToMarkdown(segments);
      assertTranscriptMarkdown(markdown, artifact);
      await this.stage('upload', artifact, () =>
        file.save(markdown, { contentType: 'text/markdown' }),
      );
      this.logger.log(`uploaded ${storagePath}`);
      status = 'uploaded';
    }
    const verdict = await this.stage('verify', artifact, () =>
      this.verify.verifyTranscript(markdown, { flavor, date: expectedDate }),
    );
    return {
      report: { storagePath, status },
      videoId,
      title,
      verdict,
      record: {
        storagePath,
        sha256: sha256Hex(markdown),
        md5: md5Base64(markdown),
        bytes: Buffer.byteLength(markdown),
      },
    };
  }

  private async producePdf(
    storagePath: string,
    force: boolean,
    entry: ArchiveEntry,
  ): Promise<{ report: IngestFileReport; record: FileRecord }> {
    const file = this.bucket.file(storagePath);
    let buf: Buffer;
    let status: 'uploaded' | 'skipped';
    const [exists] = force
      ? [false]
      : await this.stage('plan', 'tradePlanPdf', () => file.exists());
    if (exists) {
      [buf] = await this.stage('plan', 'tradePlanPdf', () => file.download());
      assertPdfBuffer(buf, 'tradePlanPdf');
      status = 'skipped';
    } else {
      buf = await this.stage('download', 'tradePlanPdf', () =>
        this.eminiplayer.downloadTradePlanPdf(entry.pageUrl),
      );
      assertPdfBuffer(buf, 'tradePlanPdf');
      await this.stage('upload', 'tradePlanPdf', () =>
        file.save(buf, { contentType: 'application/pdf' }),
      );
      this.logger.log(`uploaded ${storagePath}`);
      status = 'uploaded';
    }
    return {
      report: { storagePath, status },
      record: { storagePath, sha256: sha256Hex(buf), md5: md5Base64(buf), bytes: buf.length },
    };
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

  /** Wrap stage failures; ArchiveNotFoundError / IngestValidationError pass through. */
  private async stage<T>(
    stage: Stage,
    artifact: 'archive' | Artifact,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ArchiveNotFoundError || err instanceof IngestValidationError) throw err;
      throw new IngestStageError(stage, artifact, err as Error);
    }
  }
}
```

- [ ] **Step 4: Wire the module**

`backend/src/eminiplayer/eminiplayer.module.ts` becomes:

```ts
import { Module } from '@nestjs/common';
import { TranscriptModule } from '../transcript/transcript.module';
import { PlaywrightService } from './playwright.service';
import { EminiplayerService } from './eminiplayer.service';
import { EminiplayerVerifyService } from './eminiplayer-verify.service';
import { EminiplayerManifestService } from './eminiplayer-manifest.service';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';

@Module({
  imports: [TranscriptModule],
  providers: [
    PlaywrightService,
    EminiplayerService,
    EminiplayerVerifyService,
    EminiplayerManifestService,
    EminiplayerIngestService,
  ],
  // PlaywrightService is deliberately NOT exported: the shared page has a
  // single owner and all access must go through EminiplayerService.
  exports: [EminiplayerService, EminiplayerIngestService],
})
export class EminiplayerModule {}
```

(`FirebaseModule` is `@Global()` and exports `STORAGE_BUCKET`/`FIRESTORE`, so no import is needed here — the `LlmModule` providing `LLM_PROVIDER` is `@Global()` too.)

- [ ] **Step 5: Run the ingest tests**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-ingest.service`
Expected: PASS.

- [ ] **Step 6: Fix `eminiplayer.module.spec.ts`, then run the full suite**

The existing `eminiplayer.module.spec.ts` compiles `EminiplayerModule` in a testing module whose only other import is `ConfigModule`. Now that the module provides services injecting `STORAGE_BUCKET`, `FIRESTORE`, and `LLM_PROVIDER`, `.compile()` **will fail** with `Nest can't resolve dependencies …` — `@Global()` modules' providers only exist when those modules are somewhere in the compiled graph, and in this spec they aren't. Do NOT import the real `FirebaseModule`/`LlmModule` (live-bucket and LLM-client dependencies the constraints forbid). Instead add a stub global module to that spec's testing-module imports:

```ts
import { Global, Module } from '@nestjs/common';
import { STORAGE_BUCKET, FIRESTORE } from '../firebase/firebase.constants';
import { LLM_PROVIDER } from '../llm/llm.constants';

@Global()
@Module({
  providers: [
    { provide: STORAGE_BUCKET, useValue: {} },
    { provide: FIRESTORE, useValue: {} },
    { provide: LLM_PROVIDER, useValue: {} },
  ],
  exports: [STORAGE_BUCKET, FIRESTORE, LLM_PROVIDER],
})
class FakeGlobalsModule {}
```

and include `FakeGlobalsModule` in the `imports` array of the testing module alongside `ConfigModule`. (A root-level provider would not work — providers passed to `Test.createTestingModule` aren't visible inside `EminiplayerModule`'s own DI context; a global module's exports are.)

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/eminiplayer
git commit -m "feat(eminiplayer): ingest orchestrator with layered verification and manifest-gated commits"
```

---

### Task 7: EminiplayerController + wiring + docs

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer.controller.ts`
- Test: `backend/src/eminiplayer/eminiplayer.controller.spec.ts`
- Modify: `backend/src/app.module.ts` (register controller)
- Modify: `backend/README.md` (document the endpoints)

**Interfaces:**
- Consumes: `EminiplayerIngestService.ingest(date, force) → Promise<IngestResult>` and `IngestStageError`/`IngestValidationError` (Tasks 3/6); `ArchiveNotFoundError` (Task 2); `EminiplayerAuditService.audit() → Promise<AuditReport>` (Task 8 — the controller method for audit is added in Task 8; this task ships ingest only).
- Produces: `POST /eminiplayer/ingest?date=MMDDYYYY&force=true|false` → 200 `IngestResult` | 400 | 404 | 422 | 502. (200, not Nest's POST-default 201 — the handler carries `@HttpCode(200)`.)

- [ ] **Step 1: Write the failing tests**

`backend/src/eminiplayer/eminiplayer.controller.spec.ts`:

```ts
import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EminiplayerController } from './eminiplayer.controller';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';

const RESULT = {
  date: '07012026',
  recapDate: '06302026',
  staleRecapsRemoved: [],
  manifestPath: 'knowledge-base/es/07012026/manifest.json',
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

  it('maps IngestValidationError to 422', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(new IngestValidationError('gate failed'));
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(
      UnprocessableEntityException,
    );
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
  UnprocessableEntityException,
} from '@nestjs/common';
import { EminiplayerIngestService, IngestResult } from './eminiplayer-ingest.service';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
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
      if (err instanceof IngestValidationError) throw new UnprocessableEntityException(err.message);
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
entry before it, transcribes both YouTube videos, downloads the TP pdf, runs
layered verification (structural gates, redundant date cross-checks against
entry and video titles, an LLM content check), and uploads everything to
Firebase Storage under `knowledge-base/es/<date>/`. The day only becomes
visible to consumers when its `manifest.json` commits — after every check
passes. Existing artifacts are reused without re-scraping (`force=true`
regenerates), stale recaps from earlier runs are deleted and reported, and
concurrent requests for the same date share one run. Expect a request to take
tens of seconds up to minutes: it drives a real browser plus transcript
fetches, an LLM call, and a pdf download.

Errors: `400` bad date, `404` no matching archive entry, `422` verification
refused the data (a human should look before retrying), `502` a pipeline
stage failed (retry resumes where it left off).

**Current status:** the scraper's selector internals are stubbed — the
endpoint returns a `502` naming the failing stage (`resolve (archive)`)
until the follow-up selector work lands.
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
git commit -m "feat(eminiplayer): POST /eminiplayer/ingest with 400/404/422/502 error mapping"
```

---

### Task 8: EminiplayerAuditService + GET /eminiplayer/audit

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer-audit.service.ts`
- Test: `backend/src/eminiplayer/eminiplayer-audit.service.spec.ts`
- Modify: `backend/src/eminiplayer/eminiplayer.controller.ts` (add the audit route)
- Modify: `backend/src/eminiplayer/eminiplayer.controller.spec.ts` (audit test + provider)
- Modify: `backend/src/eminiplayer/eminiplayer.module.ts` (provide the audit service)
- Modify: `backend/README.md` (document the endpoint)

**Interfaces:**
- Consumes: `STORAGE_BUCKET` (`getFiles({prefix})` — listing carries per-object `metadata.md5Hash`/`metadata.size`; `File.download()` in deep mode only), `FIRESTORE` (`collection().get()`), `DayManifest`/`VIDEO_IDS_COLLECTION` (Task 5), gates + `sha256Hex` + `assertDayInvariants` + `ES_STORAGE_PREFIX` + `parseMmddyyyy` (Task 3).
- Produces: `interface AuditAnomaly { date: string; problem: string }`; `interface AuditOptions { from?: string; to?: string; deep?: boolean }`; `interface AuditReport { daysChecked: number; ok: number; deep: boolean; anomalies: AuditAnomaly[]; uncommittedDays: string[] }`; `EminiplayerAuditService.audit(opts?: AuditOptions): Promise<AuditReport>`; `GET /eminiplayer/audit?from=MMDDYYYY&to=MMDDYYYY&deep=true` → 200 `AuditReport` | 400 bad range param.
- Semantics: **shallow (default)** never downloads artifact content — per-file integrity via the GCS listing's `md5Hash`/`size` metadata against the manifest's `md5`/`bytes`; **`deep=true`** additionally downloads each file, re-computes `sha256`, and re-runs the structural gates. Claims are checked in **both** directions (orphaned claim in range ↔ manifested id with missing/mismatched claim). Per-file transport failures are attributed to the artifact, never reported as `manifest unreadable`.

- [ ] **Step 1: Write the failing tests**

`backend/src/eminiplayer/eminiplayer-audit.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { STORAGE_BUCKET, FIRESTORE } from '../firebase/firebase.constants';
import { EminiplayerAuditService } from './eminiplayer-audit.service';
import { md5Base64, sha256Hex } from './eminiplayer-validation';
import type { DayManifest } from './eminiplayer-manifest.service';
import type { TranscriptVerdict } from './eminiplayer-verify.service';

function plausibleMarkdown(label: string): string {
  const rows: string[] = [];
  for (let i = 0; i < 60; i++) {
    const t = i * 4;
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    rows.push(`**${mm}:${ss}** ${label} segment ${i} with enough words to count`);
  }
  return `# Transcript\n\n${rows.join('\n')}\n`;
}

function plausiblePdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'),
    Buffer.alloc(12000, 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);
}

const VERDICT: TranscriptVerdict = {
  docType: 'recap', isEsContent: true, referencedWeekday: 'none', confidence: 'high',
};

/**
 * A complete, self-consistent day. `objects` maps path -> content; metadata
 * (md5/size) is derived from content, mirroring what GCS reports. Individual
 * tests corrupt content or metadata to trip specific checks.
 */
function makeDay(date: string, recapDate: string, videoSuffix: string) {
  const dir = `knowledge-base/es/${date}`;
  const recapMd = plausibleMarkdown('recap');
  const tpMd = plausibleMarkdown('tp');
  const pdf = plausiblePdf();
  const record = (storagePath: string, content: Buffer) => ({
    storagePath,
    sha256: sha256Hex(content),
    md5: md5Base64(content),
    bytes: content.length,
  });
  const recapBuf = Buffer.from(recapMd);
  const tpBuf = Buffer.from(tpMd);
  const manifest: DayManifest = {
    version: 1,
    date,
    recapDate,
    createdAt: '2026-07-01T13:00:00.000Z',
    sources: {
      recapPageUrl: `https://www.eminiplayer.net/post/recap-${date}.aspx`,
      tradePlanPageUrl: `https://www.eminiplayer.net/post/tp-${date}.aspx`,
      recapVideoId: `recap${videoSuffix}`,
      tradePlanVideoId: `tp${videoSuffix}`,
    },
    files: {
      recap: record(`${dir}/${recapDate}_ES_RECAP.md`, recapBuf),
      tradePlanMd: record(`${dir}/${date}_ES_TP.md`, tpBuf),
      tradePlanPdf: record(`${dir}/${date}_ES_TP.pdf`, pdf),
    },
    evidence: {
      recapVideoTitle: 't1', tradePlanVideoTitle: 't2',
      recapVerdict: VERDICT,
      tradePlanVerdict: { ...VERDICT, docType: 'tradePlan' },
    },
  };
  return {
    [`${dir}/manifest.json`]: Buffer.from(JSON.stringify(manifest)),
    [`${dir}/${recapDate}_ES_RECAP.md`]: recapBuf,
    [`${dir}/${date}_ES_TP.md`]: tpBuf,
    [`${dir}/${date}_ES_TP.pdf`]: pdf,
  };
}

/** Claims that exactly mirror a makeDay(videoSuffix) manifest. */
function claimsFor(date: string, videoSuffix: string) {
  return {
    [`recap${videoSuffix}`]: { date, slot: 'recap' },
    [`tp${videoSuffix}`]: { date, slot: 'tradePlan' },
  };
}

function makeBucket(objects: Record<string, Buffer>) {
  const get = (path: string) => ({
    name: path,
    metadata: {
      md5Hash: objects[path] !== undefined ? md5Base64(objects[path]) : undefined,
      size: objects[path] !== undefined ? String(objects[path].length) : undefined,
    },
    download: jest.fn(() =>
      objects[path] !== undefined
        ? Promise.resolve([objects[path]])
        : Promise.reject(new Error('No such object')),
    ),
  });
  const files = new Map<string, ReturnType<typeof get>>();
  const memo = (path: string) => {
    if (!files.has(path)) files.set(path, get(path));
    return files.get(path)!;
  };
  return {
    files,
    file: jest.fn(memo),
    getFiles: jest.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve([Object.keys(objects).filter((p) => p.startsWith(prefix)).map(memo)]),
    ),
  };
}

function makeFirestore(claims: Record<string, { date: string; slot: string }> = {}) {
  return {
    collection: jest.fn(() => ({
      get: jest.fn(() =>
        Promise.resolve({
          docs: Object.entries(claims).map(([id, data]) => ({ id, data: () => data })),
        }),
      ),
    })),
  };
}

async function build(
  objects: Record<string, Buffer>,
  claims: Record<string, { date: string; slot: string }> = {},
) {
  const bucket = makeBucket(objects);
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerAuditService,
      { provide: STORAGE_BUCKET, useValue: bucket },
      { provide: FIRESTORE, useValue: makeFirestore(claims) },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerAuditService), bucket };
}

describe('EminiplayerAuditService.audit', () => {
  it('reports a clean corpus (shallow: no artifact downloads, metadata only)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const { service, bucket } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report).toEqual({ daysChecked: 1, ok: 1, deep: false, anomalies: [], uncommittedDays: [] });
    // shallow mode downloaded ONLY the manifest
    const downloaded = [...bucket.files.entries()]
      .filter(([, f]) => f.download.mock.calls.length > 0)
      .map(([p]) => p);
    expect(downloaded).toEqual(['knowledge-base/es/07012026/manifest.json']);
  });

  it('flags a metadata hash mismatch without downloading (stored object changed after commit)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    objects['knowledge-base/es/07012026/07012026_ES_TP.md'] = Buffer.from(plausibleMarkdown('tampered'));
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.ok).toBe(0);
    expect(report.anomalies).toEqual([
      expect.objectContaining({ date: '07012026', problem: expect.stringContaining('md5 mismatch') }),
    ]);
  });

  it('flags a missing file referenced by a manifest', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    delete objects['knowledge-base/es/07012026/07012026_ES_TP.pdf'];
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('missing'))).toBe(true);
  });

  it('deep mode re-runs gates: a hash-consistent but gate-failing artifact is caught only there', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    // corrupt the CONTENT and rewrite the manifest records to match it, so
    // every hash/size check passes and only the structural gate can object
    const bad = Buffer.from('# Transcript\n\n**00:00** way too short\n');
    const dir = 'knowledge-base/es/07012026';
    const manifest = JSON.parse(objects[`${dir}/manifest.json`].toString('utf8')) as DayManifest;
    manifest.files.tradePlanMd = {
      storagePath: `${dir}/07012026_ES_TP.md`,
      sha256: sha256Hex(bad), md5: md5Base64(bad), bytes: bad.length,
    };
    objects[`${dir}/07012026_ES_TP.md`] = bad;
    objects[`${dir}/manifest.json`] = Buffer.from(JSON.stringify(manifest));
    const claims = claimsFor('07012026', 'Vid0000001');

    const { service: shallow } = await build({ ...objects }, claims);
    expect((await shallow.audit()).anomalies).toEqual([]);

    const { service: deep } = await build({ ...objects }, claims);
    const report = await deep.audit({ deep: true });
    expect(report.deep).toBe(true);
    expect(report.anomalies.some((a) => a.problem.includes('fails its gate'))).toBe(true);
  });

  it('deep mode attributes a per-file transport failure to the artifact, not the manifest', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const { service, bucket } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    bucket.file('knowledge-base/es/07012026/07012026_ES_TP.pdf').download.mockRejectedValue(
      new Error('socket hang up'),
    );
    const report = await service.audit({ deep: true });
    expect(report.anomalies.some((a) => a.problem.includes('tradePlanPdf unreadable'))).toBe(true);
    expect(report.anomalies.some((a) => a.problem.includes('manifest unreadable'))).toBe(false);
  });

  it('flags duplicate video ids across manifests', async () => {
    const objects = {
      ...makeDay('07012026', '06302026', 'Vid0000001'),
      ...makeDay('07022026', '07012026', 'Vid0000001'), // same video ids as day 1
    };
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('also used by'))).toBe(true);
  });

  it('lists unmanifested day folders without failing them', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    objects['knowledge-base/es/07022026/07022026_ES_TP.md'] = Buffer.from(plausibleMarkdown('tp'));
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.uncommittedDays).toEqual(['07022026']);
    expect(report.daysChecked).toBe(2);
    expect(report.ok).toBe(1);
  });

  it('flags an orphaned in-range claim (no manifest references it)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const { service } = await build(objects, {
      ...claimsFor('07012026', 'Vid0000001'),
      ghostVideo001: { date: '07012026', slot: 'recap' },
    });
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('orphaned'))).toBe(true);
  });

  it('flags a manifested video id whose claim is missing (uniqueness unenforced)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const claims = claimsFor('07012026', 'Vid0000001');
    delete claims['recapVid0000001'];
    const { service } = await build(objects, claims);
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('no video-id claim'))).toBe(true);
  });

  it('range params scope which days are audited', async () => {
    const objects = {
      ...makeDay('07012026', '06302026', 'Vid0000001'),
      ...makeDay('07152026', '07142026', 'Vid0000002'),
    };
    const claims = { ...claimsFor('07012026', 'Vid0000001'), ...claimsFor('07152026', 'Vid0000002') };
    const { service } = await build(objects, claims);
    const report = await service.audit({ from: '07102026', to: '07312026' });
    expect(report.daysChecked).toBe(1);
    expect(report.ok).toBe(1);
    expect(report.anomalies).toEqual([]); // day 07012026's claims are out of range, not orphans
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-audit`
Expected: FAIL — cannot find module `./eminiplayer-audit.service`.

- [ ] **Step 3: Write the implementation**

`backend/src/eminiplayer/eminiplayer-audit.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Bucket, File } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { DayManifest, VIDEO_IDS_COLLECTION } from './eminiplayer-manifest.service';
import {
  assertDayInvariants,
  assertPdfBuffer,
  assertTranscriptMarkdown,
  ES_STORAGE_PREFIX,
  parseMmddyyyy,
  sha256Hex,
} from './eminiplayer-validation';

export interface AuditAnomaly {
  date: string;
  problem: string;
}

export interface AuditOptions {
  from?: string; // MMDDYYYY inclusive
  to?: string; // MMDDYYYY inclusive
  deep?: boolean;
}

export interface AuditReport {
  daysChecked: number;
  ok: number;
  deep: boolean;
  anomalies: AuditAnomaly[];
  uncommittedDays: string[];
}

/**
 * Read-only re-verification — the "spot check everything" button, sized for
 * a multi-year corpus. Shallow mode (default) downloads only manifests and
 * compares each artifact's md5/size against the GCS LISTING METADATA — no
 * content downloads, so a full-corpus shallow audit is one listing plus one
 * small download per day. `deep=true` additionally downloads content,
 * re-computes sha256, and re-runs the structural gates (use ranges for deep
 * runs). Does NOT re-run LLM verification (each manifest records the verdicts
 * as evidence; re-judging history costs money without new information).
 */
@Injectable()
export class EminiplayerAuditService {
  constructor(
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
    @Inject(FIRESTORE) private readonly firestore: Firestore,
  ) {}

  async audit(opts: AuditOptions = {}): Promise<AuditReport> {
    const deep = opts.deep ?? false;
    const fromT = opts.from ? parseMmddyyyy(opts.from).getTime() : -Infinity;
    const toT = opts.to ? parseMmddyyyy(opts.to).getTime() : Infinity;
    const inRange = (date: string) => {
      const t = parseMmddyyyy(date).getTime();
      return t >= fromT && t <= toT;
    };

    const [files] = await this.bucket.getFiles({ prefix: ES_STORAGE_PREFIX });
    const dayRegex = new RegExp(`^${ES_STORAGE_PREFIX}(\\d{8})/`);
    const byDay = new Map<string, Map<string, File>>(); // date -> path -> listed File
    for (const f of files) {
      const m = dayRegex.exec(f.name);
      if (!m || !inRange(m[1])) continue;
      if (!byDay.has(m[1])) byDay.set(m[1], new Map());
      byDay.get(m[1])!.set(f.name, f);
    }

    const anomalies: AuditAnomaly[] = [];
    const uncommittedDays: string[] = [];
    const videoOwners = new Map<string, string>(); // videoId -> date
    const manifestedIds = new Map<string, { date: string; slot: string }>();
    let ok = 0;

    for (const [date, dayFiles] of [...byDay.entries()].sort()) {
      const manifestFile = dayFiles.get(`${ES_STORAGE_PREFIX}${date}/manifest.json`);
      if (!manifestFile) {
        uncommittedDays.push(date);
        continue;
      }
      const before = anomalies.length;

      // The unreadable-manifest catch covers ONLY the manifest download+parse;
      // per-file failures below get attributed to their artifact.
      let manifest: DayManifest;
      try {
        const [buf] = await manifestFile.download();
        manifest = JSON.parse(buf.toString('utf8')) as DayManifest;
      } catch (err) {
        anomalies.push({ date, problem: `manifest unreadable: ${(err as Error).message}` });
        continue;
      }

      try {
        assertDayInvariants(manifest.date, manifest.recapDate);
      } catch (err) {
        anomalies.push({ date, problem: `invariants: ${(err as Error).message}` });
      }

      for (const [artifact, record] of Object.entries(manifest.files)) {
        const stored = dayFiles.get(record.storagePath);
        if (!stored) {
          anomalies.push({ date, problem: `${artifact} missing at ${record.storagePath}` });
          continue;
        }
        // Shallow integrity: the GCS listing already carries md5Hash/size.
        if (stored.metadata.md5Hash !== record.md5) {
          anomalies.push({
            date,
            problem: `${artifact} md5 mismatch — stored object differs from manifest`,
          });
        } else if (Number(stored.metadata.size) !== record.bytes) {
          anomalies.push({ date, problem: `${artifact} size mismatch` });
        }
        if (!deep) continue;
        let content: Buffer;
        try {
          [content] = await stored.download();
        } catch (err) {
          anomalies.push({ date, problem: `${artifact} unreadable: ${(err as Error).message}` });
          continue;
        }
        if (sha256Hex(content) !== record.sha256) {
          anomalies.push({ date, problem: `${artifact} sha256 mismatch` });
        }
        try {
          if (artifact === 'tradePlanPdf') assertPdfBuffer(content, artifact);
          else assertTranscriptMarkdown(content.toString('utf8'), artifact);
        } catch (err) {
          anomalies.push({ date, problem: `${artifact} fails its gate: ${(err as Error).message}` });
        }
      }

      for (const [slot, videoId] of [
        ['recap', manifest.sources.recapVideoId],
        ['tradePlan', manifest.sources.tradePlanVideoId],
      ] as const) {
        const owner = videoOwners.get(videoId);
        if (owner && owner !== date) {
          anomalies.push({ date, problem: `video ${videoId} (${slot}) also used by ${owner}` });
        }
        videoOwners.set(videoId, date);
        manifestedIds.set(videoId, { date, slot });
      }

      if (anomalies.length === before) ok += 1;
    }

    // Claims, both directions. Orphans are only judged inside the audited
    // range — an out-of-range manifest legitimately holds its claims.
    const claims = await this.firestore.collection(VIDEO_IDS_COLLECTION).get();
    const claimById = new Map(
      claims.docs.map((d) => [d.id, d.data() as { date: string; slot: string }]),
    );
    for (const [id, claim] of claimById) {
      if (inRange(claim.date) && !manifestedIds.has(id)) {
        anomalies.push({
          date: claim.date,
          problem: `orphaned video-id claim ${id} (no manifest references it)`,
        });
      }
    }
    for (const [id, want] of manifestedIds) {
      const claim = claimById.get(id);
      if (!claim || claim.date !== want.date || claim.slot !== want.slot) {
        anomalies.push({
          date: want.date,
          problem: `no video-id claim matching ${id} (${want.slot}) — uniqueness is unenforced for this video`,
        });
      }
    }

    return { daysChecked: byDay.size, ok, deep, anomalies, uncommittedDays };
  }
}
```

- [ ] **Step 4: Run the audit tests**

Run: `cd backend && pnpm test --testPathPattern=eminiplayer-audit`
Expected: PASS.

- [ ] **Step 5: Wire the route, module, and controller test**

In `eminiplayer.module.ts`, add `EminiplayerAuditService` to `providers` and `exports`. In `eminiplayer.controller.ts`, extend the `@nestjs/common` import with `Get`, and add:

```ts
import { AuditReport, EminiplayerAuditService } from './eminiplayer-audit.service';
```

change the constructor to:

```ts
constructor(
  private readonly ingestService: EminiplayerIngestService,
  private readonly auditService: EminiplayerAuditService,
) {}
```

and add the route (range params validated with the same `isValidMmddyyyy` used by ingest):

```ts
@Get('audit')
async audit(
  @Query('from') from: string | undefined,
  @Query('to') to: string | undefined,
  @Query('deep') deep: string | undefined,
): Promise<AuditReport> {
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && !isValidMmddyyyy(value)) {
      throw new BadRequestException(`Query param "${name}" must be MMDDYYYY when present`);
    }
  }
  return this.auditService.audit({ from, to, deep: deep === 'true' });
}
```

In `eminiplayer.controller.spec.ts`, change the `build` helper to construct and return the audit mock (two-line diff):

```ts
async function build() {
  const ingest = { ingest: jest.fn(() => Promise.resolve(RESULT)) };
  const audit = {
    audit: jest.fn(() =>
      Promise.resolve({ daysChecked: 0, ok: 0, deep: false, anomalies: [], uncommittedDays: [] }),
    ),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [EminiplayerController],
    providers: [
      { provide: EminiplayerIngestService, useValue: ingest },
      { provide: EminiplayerAuditService, useValue: audit },
    ],
  }).compile();
  return { controller: moduleRef.get(EminiplayerController), ingest, audit };
}
```

(also import `EminiplayerAuditService` in the spec) and add:

```ts
describe('GET /eminiplayer/audit', () => {
  it('returns the audit report, passing parsed options', async () => {
    const { controller, audit } = await build();
    await expect(controller.audit('07012026', '07312026', 'true')).resolves.toEqual({
      daysChecked: 0, ok: 0, deep: false, anomalies: [], uncommittedDays: [],
    });
    expect(audit.audit).toHaveBeenCalledWith({ from: '07012026', to: '07312026', deep: true });
  });

  it('rejects a malformed range param with 400', async () => {
    const { controller, audit } = await build();
    await expect(controller.audit('2026-07-01', undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(audit.audit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Document**

Append to the README's EminiPlayer section:

````markdown
### Audit the corpus

```bash
# shallow (default): metadata-only integrity — fast even on the full corpus
curl localhost:3000/eminiplayer/audit
# date-range + deep: downloads content, re-computes sha256, re-runs gates
curl "localhost:3000/eminiplayer/audit?from=07012026&to=07312026&deep=true"
```

Re-verifies committed days against what is actually stored: per-file
md5/size via GCS listing metadata (shallow) or full content sha256 +
structural gates (`deep=true`), date invariants, cross-day video-id
uniqueness, claim↔manifest agreement in both directions, and unmanifested
day folders. Returns `{ daysChecked, ok, deep, anomalies, uncommittedDays }`.
Run a shallow full-corpus audit before any large backtest campaign (use
ranges for deep runs); a non-empty `anomalies` list means a human should
look before trusting the data.
````

- [ ] **Step 7: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/eminiplayer backend/README.md
git commit -m "feat(eminiplayer): corpus audit service and GET /eminiplayer/audit"
```
