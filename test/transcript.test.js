import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, formatOffset, transcriptToMarkdown } from '../src/transcript.js';

test('formatOffset renders zero-padded MM:SS below one hour', () => {
  assert.equal(formatOffset(0), '00:00');
  assert.equal(formatOffset(7), '00:07');
  assert.equal(formatOffset(83.4), '01:23');
  assert.equal(formatOffset(3599), '59:59');
});

test('formatOffset grows to H:MM:SS at one hour', () => {
  assert.equal(formatOffset(3600), '1:00:00');
  assert.equal(formatOffset(3725), '1:02:05');
});

test('decodeEntities handles common and double-encoded entities', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &#39;live&#39;'), "Tom & Jerry 'live'");
  assert.equal(decodeEntities('&amp;#39;quoted&amp;#39;'), "'quoted'");
  assert.equal(decodeEntities('&lt;b&gt; &quot;hi&quot;'), '<b> "hi"');
});

test('transcriptToMarkdown renders header and lines, skips empty segments', () => {
  const md = transcriptToMarkdown([
    { text: ' first ', offset: 0, duration: 5 },
    { text: '   ', offset: 3, duration: 2 },
    { text: 'second&#39;s', offset: 83, duration: 4 },
  ]);
  assert.equal(md, "# Transcript\n\n**00:00** first\n**01:23** second's\n");
});

test('transcriptToMarkdown collapses embedded newlines to spaces', () => {
  const md = transcriptToMarkdown([
    { text: 'You know the rules\nand so do I', offset: 22, duration: 4 },
  ]);
  assert.equal(md, '# Transcript\n\n**00:22** You know the rules and so do I\n');
});
