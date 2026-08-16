/** Frontmatter parser ported verbatim from src/lineage.js parseFrontmatter. */
export function parseFrontmatter(text: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const colon = line.indexOf(':');
    if (colon === -1 || /^\s/.test(line)) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

/** Body after the frontmatter block; ported from src/features.js extractBlock. */
export function extractBlock(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text.trim();
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return text.trim();
  return lines.slice(closeIndex + 1).join('\n').trim();
}
