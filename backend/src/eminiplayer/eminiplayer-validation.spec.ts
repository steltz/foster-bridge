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
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';

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

/**
 * Same, but rendered the way the transcript formatter renders long videos:
 * `**MM:SS**` below the hour and `**H:MM:SS**` at or past it.
 */
function hourCrossingMarkdown(lines: number, startSeconds: number, stepSeconds = 4): string {
  const rows: string[] = [];
  for (let i = 0; i < lines; i++) {
    const t = startSeconds + i * stepSeconds;
    const ss = String(t % 60).padStart(2, '0');
    const stamp =
      t < 3600
        ? `${String(Math.floor(t / 60)).padStart(2, '0')}:${ss}`
        : `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${ss}`;
    rows.push(`**${stamp}** segment number ${i} with enough words to add up`);
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

/** A PDF big/valid enough to reach the page-object check, with `body` inside. */
function fixturePdfWithBody(body: string): Buffer {
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\n${body}\n`),
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

  // Task 8's audit feeds this bucket folder names it does not control, so a
  // malformed name must fail loudly instead of silently rolling over into a
  // plausible-looking Date that then passes every downstream invariant.
  it.each([
    ['070126', 'too few digits (would parse as year 0126 -> 1926)'],
    ['13012026', 'month 13 (would roll over into Jan 2027)'],
    ['02302026', 'Feb 30 (would roll over into Mar 2)'],
    ['ab012026', 'non-numeric'],
    ['0701202', 'seven digits'],
    ['070120266', 'nine digits'],
  ])('rejects malformed date %s (%s)', (date) => {
    expect(() => parseMmddyyyy(date)).toThrow(IngestValidationError);
  });

  it('accepts a real leap day', () => {
    expect(parseMmddyyyy('02292024').getUTCDate()).toBe(29);
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
    // Forms the embedded players on the archive pages realistically hand us.
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/v/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch/?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/embed/dQw4w9WgXcQ/', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=30', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=12', 'dQw4w9WgXcQ'],
  ])('extracts from %s', (url, id) => {
    expect(extractYoutubeVideoId(url)).toBe(id);
  });

  it.each([
    ['https://vimeo.com/12345'],
    ['https://www.youtube.com/watch'],
    ['https://www.eminiplayer.net/archive.aspx'],
    // Look-alike host: must NOT be treated as YouTube.
    ['https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ'],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/'],
    ['https://www.youtube.com/live/'],
    ['https://www.youtube.com/'],
    ['not a url at all'],
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

  it('accepts the real recap oEmbed title form (dash-separated MM-DD-YYYY)', () => {
    // Captured from the live channel 2026-08-14 — recap videos date with
    // dashes, TP videos with slashes.
    expect(() =>
      assertVideoTitle(
        '08-13-2026 | E-mini S&P 500 and Nasdaq-100 Futures Trading Recap (Video Lesson)',
        '08132026',
        'recap',
      ),
    ).not.toThrow();
  });

  it('accepts the real TP oEmbed title form (slash-separated MM/DD/YYYY)', () => {
    expect(() =>
      assertVideoTitle(
        '08/13/2026 E-mini S&P 500 Futures Key Support / Resistance Zones & Trade Plan',
        '08132026',
        'tradePlan',
      ),
    ).not.toThrow();
  });

  it('rejects a contradictory dash-separated date as a contradiction, not an unrecognizable format', () => {
    expect(() =>
      assertVideoTitle(
        '08-12-2026 | E-mini S&P 500 and Nasdaq-100 Futures Trading Recap (Video Lesson)',
        '08132026',
        'recap',
      ),
    ).toThrow('contains 08-12-2026');
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

  it('names format drift distinctly when a non-empty body parses to zero lines', () => {
    // CRLF line endings / a formatter change would otherwise surface as the
    // misleading "has only 0 timestamped lines" message.
    const md = `# Transcript\n\n${Array.from(
      { length: 40 },
      (_, i) => `**00:${String(i).padStart(2, '0')}** crlf line ${i} with plenty of words here\r`,
    ).join('\n')}\n`;
    expect(() => assertTranscriptMarkdown(md, 'recap')).toThrow('format drift');
  });

  it('still reports a low line count when some lines DO parse', () => {
    expect(() => assertTranscriptMarkdown(fixtureMarkdown(5), 'recap')).toThrow(
      'timestamped lines',
    );
  });

  // The H:MM:SS branch of TRANSCRIPT_LINE is what keeps a >1h video's lines
  // visible to the gate at all. If it broke, post-hour lines would be skipped
  // SILENTLY: the surviving MM:SS prefix could still look like a plausible
  // ~59-minute transcript, so both directions are pinned here.
  it('parses lines past the one-hour boundary (H:MM:SS)', () => {
    // one **59:56** line, then 29 H:MM:SS lines — dropping the latter leaves
    // a single parseable line and trips the line-count check instead
    expect(() => assertTranscriptMarkdown(hourCrossingMarkdown(30, 3596), 'recap')).not.toThrow();
  });

  it('counts H:MM:SS offsets against the max duration bound', () => {
    // starts at 2:59:56, so the parsed last offset lands past the 3h ceiling;
    // a broken three-group branch parses nothing and reports format drift
    expect(() => assertTranscriptMarkdown(hourCrossingMarkdown(30, 10796), 'recap')).toThrow(
      'duration',
    );
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

  it('accepts a PDF 1.5+ whose page dicts live in a compressed /ObjStm', () => {
    // Modern writers pack page objects into object streams, so the literal
    // "/Type /Page" never appears in the raw bytes. Rejecting these would 422
    // every ingest.
    expect(() =>
      assertPdfBuffer(fixturePdfWithBody('5 0 obj << /Type /ObjStm /N 12 >> stream'), 'tradePlanPdf'),
    ).not.toThrow();
  });

  it('rejects a PDF with neither a page marker nor an object stream', () => {
    expect(() =>
      assertPdfBuffer(fixturePdfWithBody('1 0 obj << /Type /Catalog >> endobj'), 'tradePlanPdf'),
    ).toThrow('no page objects');
  });
});

describe('IngestStageError', () => {
  it('preserves the original error as its cause', () => {
    const cause = new Error('socket hang up');
    const err = new IngestStageError('download', 'tradePlanPdf', cause);
    expect(err.cause).toBe(cause);
    expect(err.stage).toBe('download');
    expect(err.artifact).toBe('tradePlanPdf');
    expect(err.message).toContain('socket hang up');
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
