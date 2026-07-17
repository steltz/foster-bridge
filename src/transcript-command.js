import { parseArgs } from 'node:util';
import { transcriptToMarkdown } from './transcript.js';

const USAGE = 'Usage: backtest transcript <youtube-url-or-id> [--json]';

// youtube-transcript@1.3.1 returns offset and duration in MILLISECONDS
// (verified by live probe, Task 1); this divisor normalizes them to seconds at
// the command boundary so src/transcript.js always works in seconds.
export const OFFSET_DIVISOR = 1000;

async function defaultFetch(urlOrId) {
  const { YoutubeTranscript } = await import('youtube-transcript');
  return YoutubeTranscript.fetchTranscript(urlOrId);
}

export async function runTranscript(args, { fetchTranscript = defaultFetch } = {}) {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const target = positionals[0]?.trim();
  if (!target) throw new Error(USAGE);

  let raw;
  try {
    raw = await fetchTranscript(target);
  } catch (err) {
    throw new Error(`Could not fetch transcript: ${err.message}`);
  }

  const segments = raw.map((seg) => ({
    text: seg.text,
    offset: seg.offset / OFFSET_DIVISOR,
    duration: seg.duration / OFFSET_DIVISOR,
  }));

  if (values.json) {
    process.stdout.write(`${JSON.stringify(segments, null, 2)}\n`);
  } else {
    process.stdout.write(transcriptToMarkdown(segments));
  }
}
