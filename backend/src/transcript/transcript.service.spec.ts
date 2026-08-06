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
