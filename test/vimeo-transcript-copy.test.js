import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../tools/vimeo-transcript-copy.js', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/vimeo-transcript.html', import.meta.url));

// Evaluate the pasteable script and grab the global it defines. The script
// only touches document/navigator inside function bodies, so loading is safe.
const src = readFileSync(scriptPath, 'utf8');
const copyVimeoTranscript = new Function(`${src}\nreturn copyVimeoTranscript;`)();
const { extractCues, toMarkdown } = copyVimeoTranscript;

// Minimal DOM stub: a cue <li> exposing only what extractCues touches.
function stubCue(id, text, timestamp) {
  return {
    id,
    querySelector(sel) {
      if (sel.includes('cueText')) return text === null ? null : { textContent: text };
      if (sel.includes('timestamp')) return timestamp === null ? null : { textContent: timestamp };
      return null;
    },
  };
}

const stubRoot = (cues) => ({ querySelectorAll: () => cues });

// Build stub cues from the saved fixture HTML with regexes (no jsdom).
function stubsFromFixture() {
  const html = readFileSync(fixturePath, 'utf8');
  const stubs = [];
  for (const li of html.matchAll(/<li[^>]*id="(transcript-cue-\d+)"[^>]*>(.*?)<\/li>/gs)) {
    let text = null;
    let timestamp = null;
    for (const span of li[2].matchAll(/<span class="([^"]*)"[^>]*>(.*?)<\/span>/gs)) {
      if (span[1].includes('cueText')) text = span[2];
      if (span[1].includes('timestamp')) timestamp = span[2];
    }
    stubs.push(stubCue(li[1], text, timestamp));
  }
  return stubs;
}

test('extractCues reads index, timestamp, and text from rendered cues', () => {
  const cues = extractCues(stubRoot([stubCue('transcript-cue-7', ' hello world ', '01:23')]));
  assert.deepEqual(cues, [{ index: 7, timestamp: '01:23', text: 'hello world' }]);
});

test('extractCues skips cues with missing or empty text', () => {
  const cues = extractCues(stubRoot([
    stubCue('transcript-cue-0', null, '00:00'),
    stubCue('transcript-cue-1', '   ', '00:05'),
    stubCue('transcript-cue-2', 'kept', '00:10'),
  ]));
  assert.deepEqual(cues.map((c) => c.index), [2]);
});

test('extractCues substitutes --:-- for a missing timestamp and skips bad ids', () => {
  const cues = extractCues(stubRoot([
    stubCue('transcript-cue-5', 'no time', null),
    stubCue('transcript-cue-x', 'bad id', '00:01'),
  ]));
  assert.deepEqual(cues, [{ index: 5, timestamp: '--:--', text: 'no time' }]);
});

test('toMarkdown sorts by index and renders timestamped lines', () => {
  const md = toMarkdown([
    { index: 1, timestamp: '00:07', text: 'second' },
    { index: 0, timestamp: '00:00', text: 'first' },
  ]);
  assert.equal(md, '# Transcript\n\n**00:00** first\n**00:07** second\n');
});

test('fixture round-trip: real Vimeo markup parses into the expected markdown', () => {
  const cues = extractCues(stubRoot(stubsFromFixture()));
  assert.equal(cues.length, 4);
  const md = toMarkdown(cues);
  assert.match(md, /^# Transcript\n\n\*\*00:00\*\* Hey, good morning\./);
  assert.match(md, /\*\*00:25\*\* into the recent multi-day range\./);
  assert.equal(md.trim().split('\n').length, 6); // header + blank + 4 cue lines
});

test('minified build defines the same working global and helpers', () => {
  const minPath = fileURLToPath(new URL('../tools/vimeo-transcript-copy.min.js', import.meta.url));
  const minSrc = readFileSync(minPath, 'utf8');
  const minified = new Function(`${minSrc}\nreturn copyVimeoTranscript;`)();
  assert.equal(typeof minified, 'function');
  const cues = minified.extractCues(stubRoot([stubCue('transcript-cue-3', 'mini', '00:09')]));
  assert.deepEqual(cues, [{ index: 3, timestamp: '00:09', text: 'mini' }]);
  assert.equal(minified.toMarkdown(cues), '# Transcript\n\n**00:09** mini\n');
});
