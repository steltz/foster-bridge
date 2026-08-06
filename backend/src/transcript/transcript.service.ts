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
