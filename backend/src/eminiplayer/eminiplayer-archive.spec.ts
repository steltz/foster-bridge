import {
  classifyArchiveTitle,
  resolveEntryUrl,
  selectDayEntries,
  RawArchiveRow,
} from './eminiplayer-archive';
import { ArchiveNotFoundError } from './eminiplayer.constants';
import { IngestValidationError } from './eminiplayer-ingest.errors';

// Title fixtures are verbatim rows captured from the live archive listing
// (2026-08-14). Weekdays are calendar-correct: 08/13/2026 is a Thursday,
// 08/12/2026 a Wednesday.

describe('classifyArchiveTitle', () => {
  it('classifies the modern trade-plan title', () => {
    expect(
      classifyArchiveTitle('ES Key Zones and Trade Plan for Thursday 08/13/2026'),
    ).toEqual({ kind: 'tradePlan', weekday: 4, date: '08132026' });
  });

  it('classifies the abbreviated "Wed." weekday form', () => {
    expect(
      classifyArchiveTitle('ES Key Zones and Trade Plan for Wed. 08/12/2026'),
    ).toEqual({ kind: 'tradePlan', weekday: 3, date: '08122026' });
  });

  it('classifies the older "Key Levels" trade-plan era', () => {
    expect(
      classifyArchiveTitle('ES Key Levels and Trade Plan for Friday 03/07/2014'),
    ).toEqual({ kind: 'tradePlan', weekday: 5, date: '03072014' });
  });

  it('classifies the modern recap title', () => {
    expect(
      classifyArchiveTitle('ES Recap (Video Lesson) for Thursday 08/13/2026'),
    ).toEqual({ kind: 'recap', weekday: 4, date: '08132026' });
  });

  it('classifies the older "ES Recap/Video Lesson" and bare "ES Recap" eras', () => {
    expect(
      classifyArchiveTitle('ES Recap/Video Lesson for Tuesday 06/30/2026'),
    ).toEqual({ kind: 'recap', weekday: 2, date: '06302026' });
    expect(classifyArchiveTitle('ES Recap for Monday 09/12/2016')).toEqual({
      kind: 'recap',
      weekday: 1,
      date: '09122016',
    });
  });

  it('returns null for chart-only recaps, NQ posts, and announcement posts that mention "Trade Plan"', () => {
    // all verbatim from the captured listing — substring matching on
    // "trade plan"/"recap" would misfile every one of these
    expect(classifyArchiveTitle('ES Recap Charts for Monday 04/25/2016')).toBeNull();
    expect(classifyArchiveTitle('NQ Recap for Thursday 03/19/2026')).toBeNull();
    expect(classifyArchiveTitle('No Trade Plan (Holiday)')).toBeNull();
    expect(
      classifyArchiveTitle("Zones and Trade Plans Will Resume When I'm Back"),
    ).toBeNull();
    expect(
      classifyArchiveTitle(
        'Webinar: How One Member Uses the EMiniPlayer S/R Zones and Trade Plan',
      ),
    ).toBeNull();
  });

  it('returns null for a typo weekday it cannot verify (real row: "Thurday")', () => {
    expect(
      classifyArchiveTitle('ES Key Zones and Trade Plan for Thurday 10/26/2017'),
    ).toBeNull();
  });
});

describe('resolveEntryUrl', () => {
  const BASE = 'https://www.eminiplayer.net/archive.aspx';

  it('resolves the relative hrefs the listing actually uses against the archive origin', () => {
    expect(
      resolveEntryUrl('/post/2026/08/13/ES-Key-Zones-and-Trade-Plan-for-Thursday-08132026.aspx', BASE),
    ).toBe(
      'https://www.eminiplayer.net/post/2026/08/13/ES-Key-Zones-and-Trade-Plan-for-Thursday-08132026.aspx',
    );
  });

  it('accepts absolute same-origin hrefs (both www and apex)', () => {
    expect(
      resolveEntryUrl('https://www.eminiplayer.net/post/x.aspx', BASE),
    ).toBe('https://www.eminiplayer.net/post/x.aspx');
    expect(resolveEntryUrl('https://eminiplayer.net/post/x.aspx', BASE)).toBe(
      'https://eminiplayer.net/post/x.aspx',
    );
  });

  it('rejects a foreign-origin href — pageUrl flows into page.goto on a credentialed session', () => {
    expect(() => resolveEntryUrl('https://evil.example.com/post/x.aspx', BASE)).toThrow(
      IngestValidationError,
    );
    // suffix spoof of the real host must not pass the origin check
    expect(() =>
      resolveEntryUrl('https://eminiplayer.net.evil.com/post/x.aspx', BASE),
    ).toThrow(IngestValidationError);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => resolveEntryUrl('javascript:alert(1)', BASE)).toThrow(
      IngestValidationError,
    );
  });
});

describe('selectDayEntries', () => {
  const BASE = 'https://www.eminiplayer.net/archive.aspx';

  // Mirrors the top of the captured "Members Only" table: newest first, one
  // recap + one TP row per day, ISO date cell, relative post href.
  const row = (dateText: string, href: string, title: string): RawArchiveRow => ({
    dateText,
    href,
    title,
  });
  const listing: RawArchiveRow[] = [
    row('2026-08-13', '/post/2026/08/13/ES-Recap-(Video-Lesson)-for-Thursday-08132026.aspx', 'ES Recap (Video Lesson) for Thursday 08/13/2026'),
    row('2026-08-13', '/post/2026/08/13/ES-Key-Zones-and-Trade-Plan-for-Thursday-08132026.aspx', 'ES Key Zones and Trade Plan for Thursday 08/13/2026'),
    row('2026-08-12', '/post/2026/08/12/ES-Recap-(Video-Lesson)-for-Wed-08122026.aspx', 'ES Recap (Video Lesson) for Wed. 08/12/2026'),
    row('2026-08-12', '/post/2026/08/12/ES-Key-Zones-and-Trade-Plan-for-Wed-08122026.aspx', 'ES Key Zones and Trade Plan for Wed. 08/12/2026'),
    row('2026-08-11', '/post/2026/08/11/ES-Recap-(Video-Lesson)-for-Tuesday-08112026.aspx', 'ES Recap (Video Lesson) for Tuesday 08/11/2026'),
  ];

  it('returns the trade plan for the date and the most recent recap strictly before it', () => {
    const entries = selectDayEntries(listing, '08132026', BASE);
    expect(entries.tradePlan).toEqual({
      date: '08132026',
      pageUrl:
        'https://www.eminiplayer.net/post/2026/08/13/ES-Key-Zones-and-Trade-Plan-for-Thursday-08132026.aspx',
      title: 'ES Key Zones and Trade Plan for Thursday 08/13/2026',
    });
    // NOT the 08/13 recap — the recap must be dated strictly before the day
    expect(entries.recap).toEqual({
      date: '08122026',
      pageUrl:
        'https://www.eminiplayer.net/post/2026/08/12/ES-Recap-(Video-Lesson)-for-Wed-08122026.aspx',
      title: 'ES Recap (Video Lesson) for Wed. 08/12/2026',
    });
  });

  it('ignores chart-only recaps and NQ rows when picking the recap', () => {
    const rows = [
      row('2026-08-13', '/post/tp.aspx', 'ES Key Zones and Trade Plan for Thursday 08/13/2026'),
      row('2026-08-12', '/post/nq.aspx', 'NQ Recap for Wed. 08/12/2026'),
      row('2026-08-12', '/post/charts.aspx', 'ES Recap Charts for Wed. 08/12/2026'),
      row('2026-08-11', '/post/real.aspx', 'ES Recap (Video Lesson) for Tuesday 08/11/2026'),
    ];
    const entries = selectDayEntries(rows, '08132026', BASE);
    expect(entries.recap.date).toBe('08112026');
    expect(entries.recap.pageUrl).toBe('https://www.eminiplayer.net/post/real.aspx');
  });

  it('throws ArchiveNotFoundError when there is no trade-plan entry for the date', () => {
    expect(() => selectDayEntries(listing, '08142026', BASE)).toThrow(ArchiveNotFoundError);
  });

  it('throws ArchiveNotFoundError when the nearest recap is beyond the lookback bound', () => {
    const rows = [
      row('2026-08-13', '/post/tp.aspx', 'ES Key Zones and Trade Plan for Thursday 08/13/2026'),
      // 07/17/2026 is a Friday, 27 days before — outside RECAP_LOOKBACK_DAYS
      row('2026-07-17', '/post/old.aspx', 'ES Recap (Video Lesson) for Friday 07/17/2026'),
    ];
    expect(() => selectDayEntries(rows, '08132026', BASE)).toThrow(ArchiveNotFoundError);
  });

  it('rejects a row-date/title-date disagreement on the selected trade plan (off-by-one-row parse)', () => {
    const rows = [
      row('2026-08-13', '/post/tp.aspx', 'ES Key Zones and Trade Plan for Wed. 08/12/2026'),
      row('2026-08-12', '/post/recap.aspx', 'ES Recap (Video Lesson) for Wed. 08/12/2026'),
    ];
    expect(() => selectDayEntries(rows, '08132026', BASE)).toThrow(IngestValidationError);
  });

  it('rejects a weekday that contradicts the calendar date (08/13/2026 is a Thursday)', () => {
    const rows = [
      row('2026-08-13', '/post/tp.aspx', 'ES Key Zones and Trade Plan for Wed. 08/13/2026'),
      row('2026-08-12', '/post/recap.aspx', 'ES Recap (Video Lesson) for Wed. 08/12/2026'),
    ];
    expect(() => selectDayEntries(rows, '08132026', BASE)).toThrow(IngestValidationError);
  });

  it('rejects a recap row whose title date disagrees with its row date', () => {
    const rows = [
      row('2026-08-13', '/post/tp.aspx', 'ES Key Zones and Trade Plan for Thursday 08/13/2026'),
      row('2026-08-12', '/post/recap.aspx', 'ES Recap (Video Lesson) for Tuesday 08/11/2026'),
    ];
    expect(() => selectDayEntries(rows, '08132026', BASE)).toThrow(IngestValidationError);
  });

  it('rejects a foreign-origin href on a selected row', () => {
    const rows = [
      row('2026-08-13', 'https://evil.example.com/tp.aspx', 'ES Key Zones and Trade Plan for Thursday 08/13/2026'),
      row('2026-08-12', '/post/recap.aspx', 'ES Recap (Video Lesson) for Wed. 08/12/2026'),
    ];
    expect(() => selectDayEntries(rows, '08132026', BASE)).toThrow(IngestValidationError);
  });

  it('skips rows with malformed date cells instead of crashing', () => {
    const rows = [
      row('Date', '/x.aspx', 'Title'), // header row scraped by a loose selector
      ...listing,
    ];
    expect(selectDayEntries(rows, '08132026', BASE).tradePlan.date).toBe('08132026');
  });
});
