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
