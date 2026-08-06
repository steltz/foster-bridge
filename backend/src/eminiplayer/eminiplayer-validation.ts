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
