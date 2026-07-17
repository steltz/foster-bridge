import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTranscript, OFFSET_DIVISOR } from '../src/transcript-command.js';

// Capture everything the command writes to stdout.
function captureStdout() {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  return { text: () => chunks.join(''), restore: () => { process.stdout.write = original; } };
}

test('prints markdown from fetched segments', async () => {
  const cap = captureStdout();
  try {
    await runTranscript(['https://youtu.be/abc123xyz00'], {
      fetchTranscript: async () => [
        { text: 'hello', offset: 0 * OFFSET_DIVISOR, duration: 2 * OFFSET_DIVISOR },
        { text: 'world&#39;s', offset: 83 * OFFSET_DIVISOR, duration: 3 * OFFSET_DIVISOR },
      ],
    });
  } finally {
    cap.restore();
  }
  assert.equal(cap.text(), "# Transcript\n\n**00:00** hello\n**01:23** world's\n");
});

test('--json prints segments normalized to seconds', async () => {
  const cap = captureStdout();
  try {
    await runTranscript(['abc123xyz00', '--json'], {
      fetchTranscript: async () => [
        { text: 'hi', offset: 5 * OFFSET_DIVISOR, duration: 2 * OFFSET_DIVISOR },
      ],
    });
  } finally {
    cap.restore();
  }
  assert.deepEqual(JSON.parse(cap.text()), [{ text: 'hi', offset: 5, duration: 2 }]);
});

test('missing url argument throws the transcript usage', async () => {
  await assert.rejects(() => runTranscript([]), /Usage: backtest transcript/);
});

test('fetch failures are wrapped with a clear message', async () => {
  await assert.rejects(
    () =>
      runTranscript(['abc123xyz00'], {
        fetchTranscript: async () => {
          throw new Error('Transcript is disabled on this video');
        },
      }),
    /Could not fetch transcript: Transcript is disabled on this video/
  );
});
