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

const MMDDYYYY = /^\d{8}$/;

/**
 * Strict MMDDYYYY -> UTC Date. Validates the shape AND round-trips the parsed
 * fields, because `Date.UTC` silently rolls over out-of-range values: '13012026'
 * would become Jan 2027 and '02302026' would become Mar 2, both of which then
 * sail through every downstream invariant. The audit feeds this bucket folder
 * names it does not control, so a malformed name must fail loudly here.
 */
export function parseMmddyyyy(date: string): Date {
  if (!MMDDYYYY.test(date)) {
    throw new IngestValidationError(
      `date "${date}" is not in MMDDYYYY form (expected exactly 8 digits)`,
    );
  }
  const mm = Number(date.slice(0, 2));
  const dd = Number(date.slice(2, 4));
  const yyyy = Number(date.slice(4));
  const parsed = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (
    parsed.getUTCFullYear() !== yyyy ||
    parsed.getUTCMonth() !== mm - 1 ||
    parsed.getUTCDate() !== dd
  ) {
    throw new IngestValidationError(`date "${date}" is not a real calendar date`);
  }
  return parsed;
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

// Anchored at both ends so only youtube.com / youtube-nocookie.com and their
// subdomains match — "youtube.com.evil.com" must not be treated as YouTube.
const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/;

// Path shapes that carry the id as the segment right after the prefix. The
// archive's embedded players use /embed/ (often via the nocookie host), and
// links pasted into posts show up as /live/, /shorts/ and legacy /v/.
const YOUTUBE_ID_PATH_PREFIXES = ['/embed/', '/live/', '/shorts/', '/v/'];

export function extractYoutubeVideoId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IngestValidationError(`cannot extract a YouTube video id from ${url}`);
  }
  let id: string | null = null;
  if (parsed.hostname === 'youtu.be') {
    id = parsed.pathname.slice(1).split('/')[0] || null;
  } else if (YOUTUBE_HOST.test(parsed.hostname)) {
    if (/^\/watch\/?$/.test(parsed.pathname)) {
      id = parsed.searchParams.get('v');
    } else {
      const prefix = YOUTUBE_ID_PATH_PREFIXES.find((p) => parsed.pathname.startsWith(p));
      if (prefix) id = parsed.pathname.slice(prefix.length).split('/')[0] || null;
    }
  }
  if (!id || !/^[\w-]{6,20}$/.test(id)) {
    throw new IngestValidationError(`cannot extract a YouTube video id from ${url}`);
  }
  return id;
}

/**
 * Slash and dash renderings (padded and bare) of a MMDDYYYY date. Validated
 * against real oEmbed titles 2026-08-14: TP videos date with slashes
 * ("08/13/2026 E-mini S&P 500 Futures Key Support / Resistance Zones & Trade
 * Plan"), recap videos with dashes ("08-13-2026 | E-mini S&P 500 and
 * Nasdaq-100 Futures Trading Recap (Video Lesson)").
 */
function titleDateForms(date: string): string[] {
  const mm = date.slice(0, 2);
  const dd = date.slice(2, 4);
  const yyyy = date.slice(4);
  return ['/', '-'].flatMap((sep) => [
    `${mm}${sep}${dd}${sep}${yyyy}`,
    `${Number(mm)}${sep}${Number(dd)}${sep}${yyyy}`,
  ]);
}

// Flavor keywords confirmed against the same captured titles: recap titles
// carry "Trading Recap (Video Lesson)", TP titles carry "... & Trade Plan".
const FLAVOR_PATTERNS: Record<VideoFlavor, RegExp> = {
  recap: /recap|video lesson/i,
  tradePlan: /trade plan|key zones/i,
};

// Same separators as titleDateForms, so a wrong-day title in either style is
// reported as a contradiction rather than "no recognizable date".
const ANY_TITLE_DATE = /\b\d{1,2}([/-])\d{1,2}\1\d{4}\b/;

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

const TRANSCRIPT_HEADER = '# Transcript\n\n';

/**
 * Gate over the FINAL markdown (not raw segments) so the same check covers
 * freshly-generated transcripts and ones reloaded from the bucket on resume.
 * The duration bounds double as a tripwire for the youtube-transcript
 * classic-XML path, whose seconds get divided as if they were milliseconds.
 */
export function assertTranscriptMarkdown(markdown: string, label: string): void {
  if (!markdown.startsWith(TRANSCRIPT_HEADER)) {
    throw new IngestValidationError(`${label} transcript is missing the "# Transcript" header`);
  }
  const body = markdown.slice(TRANSCRIPT_HEADER.length);
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
  // A drifted line shape (CRLF endings, a formatter change) makes every line
  // skip silently, and a bare "only 0 timestamped lines" points the reader at
  // the transcript source instead of at the mismatch between formatter and
  // gate. Name that case. The line shape is deliberately NOT shared as a
  // constant with the transcript module: that module is site-agnostic and must
  // not import eminiplayer code, so this gate re-derives the format on purpose
  // and this message is what surfaces when the two drift apart.
  if (offsets.length === 0 && body.trim().length > 0) {
    throw new IngestValidationError(
      `${label} transcript has no parseable '**MM:SS**' lines but is non-empty — formatter/gate format drift?`,
    );
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
  // PDF 1.5+ writers pack page dictionaries into compressed /ObjStm object
  // streams, so the literal "/Type /Page" never appears in the raw bytes.
  // Requiring it alone would 422 every ingest of a modern PDF, so an object
  // stream counts as evidence of page content too.
  const text = buf.toString('latin1');
  if (!/\/Type\s*\/Page/.test(text) && !/\/ObjStm/.test(text)) {
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

/**
 * Calendar position of an MMDDYYYY day folder, or null when the name is
 * shape-valid but not a real date ('13012026'). Shared by every corpus walker
 * so range filtering and "is this even a day?" agree everywhere.
 */
export function dayTime(date: string): number | null {
  try {
    return parseMmddyyyy(date).getTime();
  } catch {
    return null;
  }
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
