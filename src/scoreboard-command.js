import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { computeScoreboard, renderScoreboard } from './scoreboard.js';
import { collectTraders } from './lineage.js';
import { collectFeatures } from './features.js';

// runs/<trader>/<model-alias>/<MMDDYYYY>/<variant>/run-<k>.json
export function collectCells(runsDir) {
  const cells = [];
  if (!existsSync(runsDir)) return cells;
  for (const trader of subdirs(runsDir)) {
    for (const model of subdirs(join(runsDir, trader))) {
      for (const day of subdirs(join(runsDir, trader, model))) {
        const dayDir = join(runsDir, trader, model, day);
        // Cells live one level deeper, under <variant>/. A run-*.json HERE is
        // a leftover from the pre-variant layout, or a writer that regressed
        // to it — silently skipping it would under-count the board with no
        // signal a reader could notice.
        for (const stray of readdirSync(dayDir).filter((f) => /^run-\d+\.json$/.test(f)).sort()) {
          console.warn(
            `warning: ignoring ${join(dayDir, stray)} — cells belong in a <variant>/ subdirectory`
          );
        }
        for (const variant of subdirs(dayDir)) {
          const variantDir = join(dayDir, variant);
          // Lexicographic sort is for deterministic collection order only;
          // cell order is not meaningful downstream (computeScoreboard sorts
          // runIndices numerically).
          for (const file of readdirSync(variantDir).filter((f) => /^run-\d+\.json$/.test(f)).sort()) {
            const path = join(variantDir, file);
            let cell;
            try {
              cell = JSON.parse(readFileSync(path, 'utf8'));
            } catch (err) {
              throw new Error(`${path}: ${err.message}`, { cause: err });
            }
            // The walk is purely navigational — every grouping field comes
            // from the payload, so a misfiled or mislabelled cell would be
            // silently misattributed to whatever it claims to be. Cross-check
            // the two so that becomes a named error instead.
            for (const [field, found, expected] of [
              ['trader', cell.trader, trader],
              ['model.alias', cell.model?.alias, model],
              ['day', cell.day, day],
              ['variant', cell.variant, variant],
            ]) {
              if (found !== expected) {
                throw new Error(`${path}: ${field} is "${found}" but its path says "${expected}"`);
              }
            }
            cells.push(cell);
          }
        }
      }
    }
  }
  return cells;
}

function subdirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function runScoreboard(args) {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string', default: 'runs' },
      traders: { type: 'string', default: 'traders' },
      features: { type: 'string', default: 'features' },
    },
  });
  const cells = collectCells(values.dir);
  const traders = collectTraders(values.traders);
  const features = collectFeatures(values.features);
  const markdown = cells.length
    ? renderScoreboard(computeScoreboard(cells), traders, features)
    : '# Trader Scoreboard\n\nNo benchmark cells found. Run /trader-bench to populate runs/.\n';
  mkdirSync(values.dir, { recursive: true });
  const outPath = join(values.dir, 'SCOREBOARD.md');
  writeFileSync(outPath, markdown);
  console.log(`Wrote ${outPath} (${cells.length} cells)`);
}
