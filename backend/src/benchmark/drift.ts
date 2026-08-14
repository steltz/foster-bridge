import { BenchmarkCell, cellKey } from './benchmark.types';

/**
 * Content-drift detection over recorded cell provenance.
 *
 * Every cell is stamped at submission with the sha256 of the inputs it ran
 * under (persona, general docs, feature body, feature staticDoc — see
 * CellMeta). Those hashes were written but never read back, so editing a
 * benchmarked persona used to succeed silently: the scoreboard groups by
 * (trader, alias, variant) with no hash in the key, so runs produced by two
 * different versions of a persona average into one row under one name.
 *
 * This module is the read-back. It is pure — no Nest, no IO — so the guard on
 * POST /benchmark/run and the read-only GET /benchmark/drift share one
 * implementation and one set of tests.
 */

/** Which input family a finding is about. */
export type DriftFamily = 'persona' | 'general' | 'feature' | 'staticDoc';

export type DriftKind =
  /** The file on disk no longer hashes to what existing cells recorded. */
  | 'file-drift'
  /** Existing cells disagree with each other — a row is ALREADY mixed. */
  | 'internal-drift';

/** One distinct hash observed across existing cells, with its blast radius. */
export interface RecordedHash {
  sha256: string;
  cellCount: number;
  /** Up to SAMPLE_LIMIT cell keys, for pointing a human at the affected data. */
  sampleCells: string[];
}

export interface DriftFinding {
  kind: DriftKind;
  family: DriftFamily;
  /** Trader name, feature id, or the general-docs sentinel path. */
  identity: string;
  /** Hash of what is on disk right now. */
  currentSha256: string;
  /** Every distinct hash recorded on existing cells, most-affected first. */
  recorded: RecordedHash[];
}

export interface DriftReport {
  findings: DriftFinding[];
  /** How many cells were examined, so an empty report is distinguishable from an empty collection. */
  cellsExamined: number;
}

/** The subset of RepoInputsService output this comparison needs. */
export interface DriftInputs {
  traders: { name: string; sha256: string }[];
  general: { sha256: string };
  features: { id: string; sha256: string; staticDocSha256: string | null }[];
}

/** Identity used for the general docs, which have no per-file identity of their own. */
export const GENERAL_IDENTITY = 'knowledge-base/general';

const SAMPLE_LIMIT = 3;

/**
 * Group cells by their recorded hash for one family, skipping cells where the
 * field is absent. Absent is not a mismatch: `featureSha256` is omitted for
 * base cells by design, and `staticDocSha256` is omitted both for variants
 * with no staticDoc and for cells written before that field existed. Treating
 * those as drift would abort every run against pre-existing data.
 */
function groupByHash(cells: BenchmarkCell[], pick: (c: BenchmarkCell) => string | undefined): RecordedHash[] {
  const byHash = new Map<string, { cellCount: number; sampleCells: string[] }>();
  for (const c of cells) {
    const sha = pick(c);
    if (!sha) continue;
    let entry = byHash.get(sha);
    if (!entry) {
      entry = { cellCount: 0, sampleCells: [] };
      byHash.set(sha, entry);
    }
    entry.cellCount++;
    if (entry.sampleCells.length < SAMPLE_LIMIT) entry.sampleCells.push(cellKey(c));
  }
  return [...byHash.entries()]
    .map(([sha256, e]) => ({ sha256, ...e }))
    .sort((a, b) => b.cellCount - a.cellCount || a.sha256.localeCompare(b.sha256, 'en'));
}

/**
 * Compare one family's current hash against what its cells recorded.
 * Returns null when the cells are unanimous AND agree with the current file.
 */
function compare(
  family: DriftFamily,
  identity: string,
  currentSha256: string,
  cells: BenchmarkCell[],
  pick: (c: BenchmarkCell) => string | undefined,
): DriftFinding | null {
  const recorded = groupByHash(cells, pick);
  if (recorded.length === 0) return null;
  // Cells disagreeing among themselves is the more serious condition and
  // subsumes any disagreement with the current file, so it is reported first.
  if (recorded.length > 1) return { kind: 'internal-drift', family, identity, currentSha256, recorded };
  if (recorded[0].sha256 !== currentSha256) return { kind: 'file-drift', family, identity, currentSha256, recorded };
  return null;
}

/**
 * Compare every current input against every existing cell.
 *
 * Scope matches the guard this replaces: a persona is compared against its
 * cells across ANY model, day and variant; the general docs against every
 * cell; a feature and its staticDoc against the cells of that variant.
 *
 * Cells whose trader or variant is no longer on disk are ignored — a deleted
 * persona's history is not drift, and blocking runs on it would make deleting
 * a trader impossible.
 */
export function detectDrift(inputs: DriftInputs, cells: BenchmarkCell[]): DriftReport {
  const findings: DriftFinding[] = [];

  for (const trader of inputs.traders) {
    const mine = cells.filter((c) => c.trader === trader.name);
    const finding = compare('persona', trader.name, trader.sha256, mine, (c) => c.personaSha256);
    if (finding) findings.push(finding);
  }

  const general = compare('general', GENERAL_IDENTITY, inputs.general.sha256, cells, (c) => c.generalSha256);
  if (general) findings.push(general);

  for (const feature of inputs.features) {
    const mine = cells.filter((c) => c.variant === feature.id);
    const body = compare('feature', feature.id, feature.sha256, mine, (c) => c.featureSha256);
    if (body) findings.push(body);
    if (feature.staticDocSha256) {
      const doc = compare('staticDoc', feature.id, feature.staticDocSha256, mine, (c) => c.staticDocSha256);
      if (doc) findings.push(doc);
    }
  }

  return { findings, cellsExamined: cells.length };
}

export function hasDrift(report: DriftReport): boolean {
  return report.findings.length > 0;
}

const REMEDY: Record<DriftFamily, string> = {
  persona: 'trader files are immutable once benchmarked — create a NEW trader file instead of editing this one',
  general: 'general docs are frozen once benchmarked — revert the edit, or retire the existing cells to start a new benchmark era',
  feature: 'feature files are immutable once benchmarked — create a NEW feature file (new id) instead of editing this one',
  staticDoc: 'a feature\'s static doc is frozen once benchmarked — revert the edit, or create a NEW feature pointing at the new doc',
};

/** Human-readable report, used as the 409 message and for logs. */
export function renderDrift(report: DriftReport): string {
  const lines = [`Content drift detected across ${report.cellsExamined} existing benchmark cells.`, ''];
  for (const f of report.findings) {
    const detail = f.recorded
      .map((r) => `      ${r.sha256} — ${r.cellCount} cell(s), e.g. ${r.sampleCells.join(', ')}`)
      .join('\n');
    lines.push(
      `  ${f.family} "${f.identity}" — ${
        f.kind === 'internal-drift'
          ? 'existing cells disagree with each other; results for this row are already mixed'
          : 'the file on disk changed after cells were written'
      }`,
      `    on disk now: ${f.currentSha256}`,
      `    recorded on cells:`,
      detail,
      `    remedy: ${REMEDY[f.family]}`,
      '',
    );
  }
  return lines.join('\n').trimEnd();
}
