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
