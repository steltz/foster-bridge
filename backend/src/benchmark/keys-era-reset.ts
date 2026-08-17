import { resolveModel } from './benchmark.types';

export interface EraArtifact {
  id: string;
  contentHash?: string | null;
  generatedBy?: string | null;
}

export interface EraCell {
  id: string;
  artifactSha256?: string | null;
}

export interface EraResetPlan {
  artifactIdsToDelete: string[];
  cellIdsToDelete: string[];
  keptCellCount: number;
}

const LEGACY_KEYS_ID = /^\d{8}__keys$/;

/**
 * A one-time reset so the corpus can be rebuilt in strict order.
 *
 * Deleting KEYS artifacts alone WEDGES those days: ensureKeys refuses to
 * generate when cells pin a hash matching no stored artifact ("possible deleted
 * artifact"), so the pinning cells must go too. Cells are matched by HASH
 * MEMBERSHIP, not by merely carrying an artifactSha256 — that field is the KEYS
 * hash for scorecard cells of any lineage, and the loose filter would delete
 * another provider's scoreboard irreversibly.
 *
 * Legacy unscoped `${day}__keys` docs are included when their generatedBy
 * resolves to this lineage: getKeysArtifact falls back to them, so a survivor
 * would be seen by the backfill's reuse pre-check and silently skip the day.
 */
export function planKeysEraReset(
  artifacts: EraArtifact[],
  cells: EraCell[],
  lineageAlias: string,
): EraResetPlan {
  const suffix = `__keys__${lineageAlias}`;
  const doomed = artifacts.filter(
    (a) =>
      a.id.endsWith(suffix) ||
      (LEGACY_KEYS_ID.test(a.id) && resolveModel(a.generatedBy ?? 'claude-fable-5').alias === lineageAlias),
  );
  const hashes = new Set(doomed.map((a) => a.contentHash).filter((h): h is string => Boolean(h)));
  const cellIdsToDelete = cells
    .filter((c) => c.artifactSha256 && hashes.has(c.artifactSha256))
    .map((c) => c.id);
  return {
    artifactIdsToDelete: doomed.map((a) => a.id),
    cellIdsToDelete,
    keptCellCount: cells.length - cellIdsToDelete.length,
  };
}
