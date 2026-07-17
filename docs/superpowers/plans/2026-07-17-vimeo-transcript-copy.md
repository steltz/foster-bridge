# Vimeo Transcript Copy Snippet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paste-into-DevTools script that auto-scrolls Vimeo's virtualized transcript list, harvests every cue, and copies the transcript to the clipboard as timestamped markdown.

**Architecture:** One self-contained plain script, `tools/vimeo-transcript-copy.js` (no imports/exports so it can be pasted into a console verbatim). It defines a global async `copyVimeoTranscript()`; the pure helpers `extractCues(root)` and `toMarkdown(cues)` are attached to the function object so a Node test can evaluate the script text and exercise them without a browser.

**Tech Stack:** Browser DOM APIs (scrolling, `Intl`-free), `navigator.clipboard` with `execCommand` fallback; `node:test` + a regex-built DOM stub for automated tests (repo rule: zero dependencies).

**Spec:** `docs/superpowers/specs/2026-07-17-vimeo-transcript-copy-design.md`

---

### Task 1: Snippet with tested pure helpers

**Files:**
- Create: `tools/vimeo-transcript-copy.js`
- Create: `test/fixtures/vimeo-transcript.html`
- Test: `test/vimeo-transcript-copy.test.js`

- [ ] **Step 1: Save the fixture**

Create `test/fixtures/vimeo-transcript.html` containing the transcript DOM exactly as captured from the Vimeo player (abridged here to the transcript list — this is the full fixture content):

```html
<div id="transcript-viewer" class="Transcript_lazy_module_transcript__4f2662ee" data-component-type="transcript" aria-label="Transcript">
  <div class="TranscriptList_lazy_module_container__f67b6693">
    <div class="TranscriptList_lazy_module_listContainer__f67b6693">
      <ul class="TranscriptList_lazy_module_list__f67b6693" id="transcript-list" data-component-type="loaded-transcript" role="listbox" aria-label="Transcript List" style="height: 1880px;">
        <li role="option" id="transcript-cue-0" class="TranscriptCue_lazy_module_cueListItem__d61e74ab TranscriptCue_lazy_module_isCurrentTime__d61e74ab" style="transform: translateY(0px);"><span class="TranscriptCue_lazy_module_cueText__d61e74ab" dir="ltr">Hey, good morning. Let's go over today's trade plan. So in the overnight session, we've seen liquidation and a multi-day balance</span><span class="TranscriptCue_lazy_module_timestamp__d61e74ab">00:00</span></li>
        <li role="option" id="transcript-cue-1" class="TranscriptCue_lazy_module_cueListItem__d61e74ab TranscriptCue_lazy_module_inactive__d61e74ab" style="transform: translateY(106px);"><span class="TranscriptCue_lazy_module_cueText__d61e74ab" dir="ltr">breakdown in the NASDAQ. So heading into the open, we know that the sell side is in firm control, and now the bigger</span><span class="TranscriptCue_lazy_module_timestamp__d61e74ab">00:07</span></li>
        <li role="option" id="transcript-cue-2" class="TranscriptCue_lazy_module_cueListItem__d61e74ab TranscriptCue_lazy_module_inactive__d61e74ab" style="transform: translateY(192px);"><span class="TranscriptCue_lazy_module_cueText__d61e74ab" dir="ltr">question is whether we're going to see downside continuation or are responsive buyers now going to step in at significant support and try to push the market back up</span><span class="TranscriptCue_lazy_module_timestamp__d61e74ab">00:14</span></li>
        <li role="option" id="transcript-cue-3" class="TranscriptCue_lazy_module_cueListItem__d61e74ab TranscriptCue_lazy_module_inactive__d61e74ab" style="transform: translateY(318px);"><span class="TranscriptCue_lazy_module_cueText__d61e74ab" dir="ltr">into the recent multi-day range. On the upside, we have aggressive resistance at 7518.5 to 31.5. Holding below that area would be a sign of continued</span><span class="TranscriptCue_lazy_module_timestamp__d61e74ab">00:25</span></li>
      </ul>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Write the failing tests**

Create `test/vimeo-transcript-copy.test.js`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/vimeo-transcript-copy.test.js`
Expected: FAIL — `ENOENT ... tools/vimeo-transcript-copy.js`

- [ ] **Step 4: Write the implementation**

Create `tools/vimeo-transcript-copy.js`:

```js
/*
 * Vimeo transcript → markdown clipboard snippet.
 *
 * Usage: paste this whole file into the Chrome DevTools console on a page
 * with the Vimeo Transcript panel open, then run:
 *
 *   await copyVimeoTranscript()
 *
 * If the player is an iframe embed, first switch the console context
 * dropdown (top-left of the Console panel, usually "top") to the Vimeo
 * player frame. If clipboard writes are blocked, re-copy with:
 *
 *   copy(copyVimeoTranscript.last)
 */
async function copyVimeoTranscript() {
  const doc = document;
  const list = doc.querySelector('ul#transcript-list');
  if (!list) {
    throw new Error(
      'No transcript list found. Open the Transcript panel first; for iframe embeds, ' +
      'switch the DevTools console context dropdown from "top" to the Vimeo player frame and rerun.'
    );
  }

  // The list itself may not scroll; find the nearest scrollable ancestor.
  let scroller = list;
  for (let el = list; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1) {
      scroller = el;
      break;
    }
  }

  const settle = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))
    );

  const collected = new Map();
  const sweep = () => {
    let added = 0;
    for (const cue of copyVimeoTranscript.extractCues(doc)) {
      if (!collected.has(cue.index)) {
        collected.set(cue.index, cue);
        added += 1;
      }
    }
    return added;
  };

  const originalTop = scroller.scrollTop;
  scroller.scrollTop = 0;
  await settle();

  const step = Math.max(50, Math.floor(scroller.clientHeight * 0.8));
  for (;;) {
    sweep();
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    await settle();
    if (scroller.scrollTop === before) break; // container refused to scroll further
  }
  while (sweep() > 0) await settle(); // final sweeps until nothing new renders
  scroller.scrollTop = originalTop;

  if (collected.size === 0) {
    throw new Error('Transcript list found but no cues rendered. Is the transcript loaded?');
  }

  const markdown = copyVimeoTranscript.toMarkdown([...collected.values()]);
  copyVimeoTranscript.last = markdown;

  let method = null;
  try {
    await navigator.clipboard.writeText(markdown);
    method = 'navigator.clipboard';
  } catch {
    const ta = doc.createElement('textarea');
    ta.value = markdown;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    if (ok) method = 'execCommand fallback';
  }

  if (method) {
    console.log(`Copied ${collected.size} transcript cues to clipboard via ${method}.`);
  } else {
    console.error('Clipboard blocked by the browser. Re-copy with: copy(copyVimeoTranscript.last)');
  }
  return markdown;
}

// Pure helpers, attached so Node tests can reach them without a browser.
copyVimeoTranscript.extractCues = function extractCues(root) {
  const cues = [];
  for (const li of root.querySelectorAll('li[id^="transcript-cue-"]')) {
    const index = Number(li.id.slice('transcript-cue-'.length));
    if (!Number.isInteger(index)) continue;
    const text = (li.querySelector('span[class*="cueText"]')?.textContent ?? '').trim();
    if (!text) continue;
    const timestamp =
      (li.querySelector('span[class*="timestamp"]')?.textContent ?? '').trim() || '--:--';
    cues.push({ index, timestamp, text });
  }
  return cues;
};

copyVimeoTranscript.toMarkdown = function toMarkdown(cues) {
  const lines = [...cues]
    .sort((a, b) => a.index - b.index)
    .map((cue) => `**${cue.timestamp}** ${cue.text}`);
  return `# Transcript\n\n${lines.join('\n')}\n`;
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/vimeo-transcript-copy.test.js`
Expected: PASS — 5 tests pass

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — 39 tests (34 existing + 5 new), 0 fail

- [ ] **Step 7: Commit**

```bash
git add tools/vimeo-transcript-copy.js test/fixtures/vimeo-transcript.html test/vimeo-transcript-copy.test.js
git commit -m "feat: vimeo transcript to markdown clipboard snippet"
```

---

### Task 2: Manual browser verification (user-run)

**Files:** none (verification only)

The scroll/clipboard behavior can only be proven in a real browser; this task is performed by the user, not an agent.

- [ ] **Step 1: Load the snippet**

Open the Vimeo video page, open the Transcript panel, open DevTools → Console. For iframe embeds, switch the console context dropdown from `top` to the Vimeo player frame. Paste the entire contents of `tools/vimeo-transcript-copy.js` and press Enter.

- [ ] **Step 2: Run it**

Run: `await copyVimeoTranscript()`
Expected: the transcript panel visibly scrolls top-to-bottom over a few seconds, then the console logs `Copied <N> transcript cues to clipboard via <method>.` and the scroll position returns to where it was.

- [ ] **Step 3: Verify the clipboard**

Paste into any editor. Expected: `# Transcript` header, then one `**MM:SS** text` line per cue, starting at `00:00` and ending at the video's final cue — i.e. the full transcript, not just the visible window. If the console instead printed the clipboard-blocked error, run `copy(copyVimeoTranscript.last)` and paste again.

- [ ] **Step 4: Report back**

If the live run fails (wrong cue count, scroll stuck, selector misses), capture the console error plus a snippet of the current DOM and file it back into a debugging session — the fixture in `test/fixtures/vimeo-transcript.html` should then be updated to match the real markup.
