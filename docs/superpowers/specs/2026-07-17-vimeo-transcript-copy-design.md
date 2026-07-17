# Vimeo Transcript Copy Snippet — Design Spec

**Date:** 2026-07-17
**Status:** Approved design, pending implementation plan

## Purpose

A single-file JavaScript snippet, pasted into the Chrome DevTools console on a
page with an open Vimeo transcript panel, that harvests the full transcript
and copies it to the clipboard as timestamped markdown. Supports the trading
workflow: turning daily trade-plan videos into text that can be cross-checked
against chart data (e.g. with the backtest CLI).

## Non-goals

- No browser extension, bookmarklet packaging, or UI.
- No fetching of Vimeo's caption-track files or other private APIs — DOM
  scraping only.
- No speaker labels or prose reflow: one markdown line per cue, timestamped.
- No support for players other than the Vimeo transcript DOM described below.

## Target DOM (observed 2026-07-17)

- Container: `#transcript-viewer`, list: `ul#transcript-list`.
- Cues: `li[id^="transcript-cue-"]` where the id suffix is the cue's ordinal
  (`transcript-cue-0`, `transcript-cue-1`, ...).
- Within each cue: text in `span[class*="cueText"]`, timestamp (`MM:SS` or
  `HH:MM:SS`) in `span[class*="timestamp"]`. Class names are CSS-module
  hashed, so selectors match on the stable substring, never the full class.
- **The list is virtualized**: only cues near the scroll position exist in the
  DOM (`li` elements are absolutely positioned via `translateY`; the `ul` has a
  fixed pixel height). Scrolling re-renders the visible window.
- The player may be an iframe embed; the transcript DOM then lives in the
  iframe's document, not the top frame.

## Interface

Pasting the script defines one global:

```js
copyVimeoTranscript() // async; returns the markdown string
```

- On success: transcript markdown is on the clipboard; the function logs the
  cue count and copy method used, and returns the markdown.
- The most recent markdown is also stored on
  `copyVimeoTranscript.last` so the user can re-copy with DevTools' built-in
  `copy(copyVimeoTranscript.last)` if clipboard writes were blocked.

## Behavior

1. **Locate.** Find `ul#transcript-list` in the current document. If missing,
   throw an error with guidance: open the Transcript panel, and if the player
   is an iframe embed, switch the DevTools console frame context to the Vimeo
   frame.
2. **Find the scroll container.** Walk up from the list to the first ancestor
   with `scrollHeight > clientHeight` (fallback: the list itself).
3. **Harvest by auto-scroll.** Remember the original `scrollTop`. Scroll to
   the top, then repeatedly:
   - collect all rendered `li[id^="transcript-cue-"]` into a `Map` keyed by
     cue ordinal (`{ index, timestamp, text }`), so re-renders dedupe for free;
   - advance `scrollTop` by ~80% of `clientHeight`;
   - wait ~150 ms (two `requestAnimationFrame`s plus a timeout) for the
     virtualized list to render.
   Stop when the container is scrolled to the bottom AND a final sweep adds no
   new cues. Then restore the original `scrollTop`.
4. **Render markdown.** Sort cues by numeric ordinal and emit:

   ```markdown
   # Transcript

   **00:00** First cue text
   **00:07** Second cue text
   ```

   A cue with missing text is skipped; a cue with missing timestamp renders
   with `--:--` in place of the time.
5. **Copy.** Try `navigator.clipboard.writeText`. If it rejects (typically
   `NotAllowedError` because DevTools has focus), fall back to a hidden
   textarea + `document.execCommand('copy')`. Log which method succeeded, or —
   if both fail — log the `copy(copyVimeoTranscript.last)` recovery command.
   The markdown is returned and stored on `.last` regardless.

## Error handling

Every failure mode produces one clear `console.error` (or thrown Error)
naming the fix: transcript panel not open / wrong console frame; zero cues
found after scrolling; clipboard blocked (with the manual `copy()` recovery
line). The scroll position is restored even when copying fails.

## File location

`tools/vimeo-transcript-copy.js` in this repo — plain script (no
imports/exports) so it can be pasted into a console verbatim. A short usage
comment sits at the top of the file.

## Testing

- **Automated (Node):** the pasted HTML from the request is saved as
  `test/fixtures/vimeo-transcript.html`. A `node:test` suite exercises the
  pure parts — cue extraction from a document-like structure and markdown
  rendering — using a minimal hand-rolled DOM stub (no jsdom dependency, in
  keeping with the repo's zero-dependency rule). The scroll/clipboard parts
  are browser-only and are excluded from automated tests.
- **Manual:** one live run in Chrome on a real Vimeo trade-plan video,
  verifying the clipboard contains the full transcript from 00:00 to the end
  (not just the visible window).

To keep the pasteable file self-contained while allowing Node tests, the
script exposes its pure helpers on the `copyVimeoTranscript` function object
(`copyVimeoTranscript.extractCues`, `copyVimeoTranscript.toMarkdown`), and the
test file loads the script text and evaluates it in a stubbed context.
