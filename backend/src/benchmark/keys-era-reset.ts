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

// True when a doc belongs to this lineage's KEYS corpus: either a scoped
// `${day}__keys__${alias}` doc, or a legacy unscoped `${day}__keys` doc whose
// generatedBy resolves to the lineage. Shared with the runner script's
// post-condition so both sides apply the identical predicate.
export function isLineageKeysDoc(a: EraArtifact, lineageAlias: string): boolean {
  return (
    a.id.endsWith(`__keys__${lineageAlias}`) ||
    (LEGACY_KEYS_ID.test(a.id) && resolveModel(a.generatedBy ?? 'claude-fable-5').alias === lineageAlias)
  );
}

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
  const doomed = artifacts.filter((a) => isLineageKeysDoc(a, lineageAlias));
  // A doomed artifact without a contentHash would still be deleted, but its
  // pinning cells could not be identified — leaving pins that match no stored
  // artifact, the exact wedge (ensureKeys' "possible deleted artifact" refusal)
  // this reset exists to avoid. Refuse to plan at all rather than plan a wedge.
  const hashless = doomed.filter((a) => !a.contentHash).map((a) => a.id);
  if (hashless.length) {
    throw new Error(
      `refusing to plan a reset: KEYS artifact(s) ${hashless.join(', ')} have no contentHash, so their pinning cells cannot be identified and those days would wedge`,
    );
  }
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
