// Decodes the entities YouTube captions actually contain. &amp; is decoded
// FIRST so double-encoded forms like &amp;#39; unwrap fully to an apostrophe.
export function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Seconds -> "MM:SS", or "H:MM:SS" from one hour up.
export function formatOffset(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function transcriptToMarkdown(segments) {
  const lines = [];
  for (const seg of segments) {
    const text = decodeEntities(String(seg.text ?? '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`**${formatOffset(seg.offset)}** ${text}`);
  }
  return `# Transcript\n\n${lines.join('\n')}\n`;
}
