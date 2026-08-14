import {
  ArchiveEntry,
  ArchiveNotFoundError,
  DayEntries,
  RECAP_LOOKBACK_DAYS,
} from './eminiplayer.constants';
import { IngestValidationError } from './eminiplayer-ingest.errors';
import { parseMmddyyyy } from './eminiplayer-validation';

/**
 * Pure parsing/selection over the archive listing — everything findDayEntries
 * does that doesn't need a browser lives here, testable against captured
 * markup. Title/date/weekday forms below were validated against the full
 * listing (8,419 rows) captured 2026-08-14.
 */

/** One listing row as scraped: ISO date cell, anchor href, anchor text. */
export interface RawArchiveRow {
  dateText: string;
  href: string;
  title: string;
}

export interface ClassifiedTitle {
  kind: 'tradePlan' | 'recap';
  /** 1=Mon..5=Fri, from the weekday token printed in the title. */
  weekday: number;
  /** MMDDYYYY, from the date printed in the title. */
  date: string;
}

// Every weekday token observed in the corpus, normalized lowercase without the
// trailing period: full names plus the site's habitual "Wed." abbreviation.
// Unknown tokens (three typos in 14 years, e.g. "Thurday") make the row
// unclassifiable rather than guessed at.
const WEEKDAY_TOKENS: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
};

// Anchored titles, not keyword tests: the listing also carries "ES Recap
// Charts for ..." (no video), "NQ Recap for ..." (wrong instrument), and
// announcement posts that mention "Trade Plan" in prose.
const TP_TITLE =
  /^ES Key (?:Zones|Levels) and Trade Plan for ([A-Za-z]+)\.? (\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const RECAP_TITLE =
  /^ES Recap(?: \(Video Lesson\)|\/Video Lesson)? for ([A-Za-z]+)\.? (\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Classify a listing title; null when it is not an ES trade-plan/recap entry. */
export function classifyArchiveTitle(title: string): ClassifiedTitle | null {
  const trimmed = title.trim();
  for (const [kind, re] of [
    ['tradePlan', TP_TITLE],
    ['recap', RECAP_TITLE],
  ] as const) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const weekday = WEEKDAY_TOKENS[m[1].toLowerCase()];
    if (weekday === undefined) return null;
    const date = `${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}${m[4]}`;
    return { kind, weekday, date };
  }
  return null;
}

// Same host rule as EminiplayerService.assertOnArchivePage: apex or any
// subdomain of eminiplayer.net, nothing else.
const ENTRY_HOST = /(^|\.)eminiplayer\.net$/;

/**
 * Resolve a scraped href to an absolute URL and require it same-origin —
 * the result flows into page.goto on a credentialed session, so a listing
 * that somehow carries a foreign link must die here, not get navigated to.
 */
export function resolveEntryUrl(href: string, baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new IngestValidationError(`archive entry href "${href}" is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new IngestValidationError(
      `archive entry href "${href}" has a non-http(s) scheme`,
    );
  }
  if (!ENTRY_HOST.test(url.hostname)) {
    throw new IngestValidationError(
      `archive entry href "${href}" resolves off-origin to ${url.hostname}`,
    );
  }
  return url.toString();
}

/** "YYYY-MM-DD" (the listing's date cell) -> MMDDYYYY, or null if malformed. */
function rowDateToMmddyyyy(dateText: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  return m ? `${m[2]}${m[3]}${m[1]}` : null;
}

interface Candidate {
  kind: 'tradePlan' | 'recap';
  rowDate: string;
  rowTime: number;
  classified: ClassifiedTitle;
  raw: RawArchiveRow;
}

/**
 * Three-way date agreement on a row we are about to act on: the date cell,
 * the date printed in the title, and the title's printed weekday against what
 * that calendar date actually falls on. An off-by-one-row parse or a
 * mislabeled post must fail loudly here, never file a document under the
 * wrong day.
 */
function assertRowAgreement(c: Candidate): void {
  if (c.classified.date !== c.rowDate) {
    throw new IngestValidationError(
      `archive row dated ${c.rowDate} carries title "${c.raw.title}" dated ${c.classified.date} — row/title date disagreement`,
    );
  }
  const actualWeekday = parseMmddyyyy(c.rowDate).getUTCDay();
  if (c.classified.weekday !== actualWeekday) {
    throw new IngestValidationError(
      `archive title "${c.raw.title}" prints a weekday that ${c.rowDate} does not fall on`,
    );
  }
}

function toEntry(c: Candidate, baseUrl: string): ArchiveEntry {
  assertRowAgreement(c);
  return {
    date: c.rowDate,
    pageUrl: resolveEntryUrl(c.raw.href, baseUrl),
    title: c.raw.title.trim(),
  };
}

/**
 * Pick the trade-plan entry for `date` (MMDDYYYY) and the most recent recap
 * entry dated strictly before it, within RECAP_LOOKBACK_DAYS. Rows that are
 * not classifiable ES trade-plan/recap entries (charts-only recaps, NQ posts,
 * announcements, header rows, weekday typos) are skipped; disagreement on a
 * row that WAS selected throws IngestValidationError.
 */
export function selectDayEntries(
  rows: RawArchiveRow[],
  date: string,
  baseUrl: string,
): DayEntries {
  const target = parseMmddyyyy(date).getTime();
  const candidates: Candidate[] = [];
  for (const raw of rows) {
    const rowDate = rowDateToMmddyyyy(raw.dateText);
    if (!rowDate) continue;
    const classified = classifyArchiveTitle(raw.title);
    if (!classified) continue;
    let rowTime: number;
    try {
      rowTime = parseMmddyyyy(rowDate).getTime();
    } catch {
      continue; // shape-valid but impossible date — skip, not fatal for the whole day
    }
    candidates.push({ kind: classified.kind, rowDate, rowTime, classified, raw });
  }

  const tp = candidates.find((c) => c.kind === 'tradePlan' && c.rowDate === date);
  if (!tp) {
    throw new ArchiveNotFoundError(`no trade-plan entry in the archive for ${date}`);
  }

  let recap: Candidate | undefined;
  let recapTime = -Infinity;
  for (const c of candidates) {
    if (c.kind !== 'recap') continue;
    const t = c.rowTime;
    if (t >= target) continue; // strictly before the requested day
    if ((target - t) / 86_400_000 > RECAP_LOOKBACK_DAYS) continue;
    if (t > recapTime) {
      recap = c;
      recapTime = t;
    }
  }
  if (!recap) {
    throw new ArchiveNotFoundError(
      `no ES recap entry within ${RECAP_LOOKBACK_DAYS} days strictly before ${date}`,
    );
  }

  return { tradePlan: toEntry(tp, baseUrl), recap: toEntry(recap, baseUrl) };
}

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
