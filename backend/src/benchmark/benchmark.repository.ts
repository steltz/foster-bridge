import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { BenchmarkCell, cellKey, resolveModel, SCORECARD_VARIANT } from './benchmark.types';

export type BatchStatus =
  | 'submitted'
  | 'in_progress'
  | 'ended'
  | 'reconciled'
  | 'errored'
  | 'canceled'
  | 'expired';

// Statuses that still need reconciler attention.
export const NON_TERMINAL: BatchStatus[] = ['submitted', 'in_progress', 'ended'];

// Per-cell provenance threaded from discovery through the batch so the
// reconciler can persist design-§4 content hashes onto every cell. The customId
// key (a cellKey) already encodes trader/modelAlias/day/variant/runIndex; this
// carries only what the key does NOT: the backtest date and the content hashes.
export interface CellMeta {
  date: string; // YYYY-MM-DD
  personaSha256: string;
  generalSha256: string;
  featureSha256?: string; // omitted for base
  staticDocSha256?: string; // omitted when the variant has no staticDoc
  artifactSha256?: string; // sha256 of the KEYS content (scorecard cells only)
}

export interface BatchDoc {
  batchId: string;
  day: string; // MMDDYYYY
  date: string; // YYYY-MM-DD
  pdfPrefix: string; // TP filename prefix, for re-warm/rebuild
  model: { alias: string; id: string };
  status: BatchStatus;
  customIdToCell: Record<string, CellMeta>;
  submittedAt: string;
  endedAt?: string;
}

export type DayArtifactKind = 'pdfFile' | 'tpTranscript' | 'recapTranscript' | 'keys';

export interface DayArtifactDoc {
  contentHash: string;
  gcsPath: string;
  providerFileId?: string; // pdfFile only (neutral provider file id)
  /** @deprecated legacy Anthropic-named field; read-compat only. */
  anthropicFileId?: string;
  // Which llm.provider minted the stored file id. A file id is only meaningful to
  // the provider that issued it (an Anthropic `file_…` id is meaningless to
  // Moonshot and vice versa), so the id alone is not enough to know whether it is
  // usable — see DayArtifactsService.usableFileId. Absent on docs written before
  // this field existed; those are all Anthropic-era (see that method's comment).
  fileProvider?: string;
  content?: string; // transcripts / keys inline copy
  uploadedAt: string;
  // Seven-keys ('keys') provenance (Plan 2). The KEYS markdown in `content` also
  // carries a YAML-frontmatter copy of these (that is the injectable artifact); the
  // top-level fields make provenance queryable without parsing the markdown.
  generatedBy?: string;
  generatedAt?: string;
  lookbackSources?: string[];
  verified?: boolean;
  // sha256 of the exact generation inputs (PDF bytes + both transcripts + methods
  // doc). ensureKeys reuses a not-yet-benchmarked artifact only while this matches,
  // so a corrected trade plan regenerates instead of serving stale KEYS.
  inputsHash?: string;
  // The recent prior complete day(s) that had no KEYS when this was generated —
  // a reduced-lookback signal (empty in the common case).
  lookbackMissing?: string[];
}

export interface SampleDoc {
  name: string;
  days: string[]; // MMDDYYYY keys, sorted chronologically
  requestedCount: number;
  poolSize: number; // eligible days at creation time
  from: string | null; // requested range bound, if any
  to: string | null;
  createdAt: string;
}

export interface ScoreboardDoc {
  json: unknown;
  markdown: string;
  generatedAt: string;
}

const RUNS = 'benchmarkRuns';
const BATCHES = 'benchmarkBatches';
const ARTIFACTS = 'dayArtifacts';
const SCOREBOARD = 'benchmarkScoreboard';
const SAMPLES = 'samples';

@Injectable()
export class BenchmarkRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  /** Write-once; a concurrent/duplicate write (ALREADY_EXISTS, gRPC code 6) is swallowed. */
  async createCell(cell: BenchmarkCell): Promise<void> {
    const id = cellKey({
      trader: cell.trader,
      modelAlias: cell.modelAlias,
      day: cell.day,
      variant: cell.variant,
      runIndex: cell.runIndex,
    });
    try {
      await this.db.collection(RUNS).doc(id).create(cell as any);
    } catch (err) {
      if ((err as { code?: number }).code === 6) return; // ALREADY_EXISTS
      throw err;
    }
  }

  async existingRunIndices(trader: string, modelAlias: string, day: string, variant: string): Promise<number[]> {
    const snap = await this.db
      .collection(RUNS)
      .where('trader', '==', trader)
      .where('modelAlias', '==', modelAlias)
      .where('day', '==', day)
      .where('variant', '==', variant)
      .get();
    return snap.docs.map((d) => (d.data() as BenchmarkCell).runIndex);
  }

  // Every KEYS content hash pinned by the day's persisted scorecard cells (via
  // artifactSha256, any model). A keys doc whose contentHash appears here is
  // immutable — regenerating it would orphan those cells' provenance. Hash-exact
  // so one flagship's pins never freeze another flagship's lineage.
  async pinnedKeysHashes(day: string): Promise<Set<string>> {
    const snap = await this.db
      .collection(RUNS)
      .where('day', '==', day)
      .where('variant', '==', SCORECARD_VARIANT)
      .get();
    const hashes = new Set<string>();
    for (const d of snap.docs) {
      const sha = (d.data() as BenchmarkCell).artifactSha256;
      if (sha) hashes.add(sha);
    }
    return hashes;
  }

  async listCells(modelAlias: string): Promise<BenchmarkCell[]> {
    const snap = await this.db.collection(RUNS).where('modelAlias', '==', modelAlias).get();
    return snap.docs.map((d) => d.data() as BenchmarkCell);
  }

  /**
   * Every cell across every model, for the content-drift comparison — a
   * persona is frozen by ANY cell that ran on it, not just cells for the model
   * currently being run, so this deliberately cannot be model-scoped like
   * listCells. Projected to the identity + provenance fields: drift never
   * reads setup/result, and those are the bulk of a cell's bytes.
   */
  async listCellsForDrift(): Promise<BenchmarkCell[]> {
    const snap = await this.db
      .collection(RUNS)
      .select(
        'trader',
        'modelAlias',
        'day',
        'variant',
        'runIndex',
        'personaSha256',
        'generalSha256',
        'featureSha256',
        'staticDocSha256',
      )
      .get();
    return snap.docs.map((d) => d.data() as BenchmarkCell);
  }

  async saveBatch(doc: BatchDoc): Promise<void> {
    await this.db.collection(BATCHES).doc(doc.batchId).set(doc as any);
  }

  async nonTerminalBatches(): Promise<BatchDoc[]> {
    const snap = await this.db.collection(BATCHES).where('status', 'in', NON_TERMINAL).get();
    return snap.docs.map((d) => d.data() as BatchDoc);
  }

  async updateBatch(batchId: string, patch: Partial<BatchDoc>): Promise<void> {
    await this.db.collection(BATCHES).doc(batchId).update(patch as any);
  }

  async getDayArtifact(day: string, kind: DayArtifactKind): Promise<DayArtifactDoc | null> {
    const snap = await this.db.collection(ARTIFACTS).doc(`${day}__${kind}`).get();
    return snap.exists ? (snap.data() as DayArtifactDoc) : null;
  }

  async saveDayArtifact(day: string, kind: DayArtifactKind, doc: DayArtifactDoc): Promise<void> {
    await this.db.collection(ARTIFACTS).doc(`${day}__${kind}`).set(doc as any);
  }

  /**
   * KEYS artifacts are keyed per provider-flagship lineage (`${day}__keys__${alias}`)
   * so a Kimi bench never consumes — or overwrites — Fable-generated keys. Reads
   * fall back to the legacy unscoped `${day}__keys` doc, but only when its
   * `generatedBy` resolves to the requested alias: existing Fable-era docs become
   * the Fable lineage with no migration, and stay invisible to every other lineage.
   * A legacy doc with no `generatedBy` predates the field — all such docs are
   * Anthropic-era Fable (same reasoning as DayArtifactDoc.fileProvider).
   */
  async getKeysArtifact(day: string, flagshipAlias: string): Promise<DayArtifactDoc | null> {
    const scoped = await this.db.collection(ARTIFACTS).doc(`${day}__keys__${flagshipAlias}`).get();
    if (scoped.exists) return scoped.data() as DayArtifactDoc;
    const legacy = await this.getDayArtifact(day, 'keys');
    if (!legacy) return null;
    const legacyAlias = resolveModel(legacy.generatedBy ?? 'claude-fable-5').alias;
    return legacyAlias === flagshipAlias ? legacy : null;
  }

  /** New KEYS saves always use the lineage-scoped id; the legacy id is read-only. */
  async saveKeysArtifact(day: string, flagshipAlias: string, doc: DayArtifactDoc): Promise<void> {
    await this.db.collection(ARTIFACTS).doc(`${day}__keys__${flagshipAlias}`).set(doc as any);
  }

  async getScoreboard(modelAlias: string): Promise<ScoreboardDoc | null> {
    const snap = await this.db.collection(SCOREBOARD).doc(modelAlias).get();
    return snap.exists ? (snap.data() as ScoreboardDoc) : null;
  }

  async saveScoreboard(modelAlias: string, doc: ScoreboardDoc): Promise<void> {
    await this.db.collection(SCOREBOARD).doc(modelAlias).set(doc as any);
  }

  /** Write-once; duplicate create surfaces the raw ALREADY_EXISTS (code 6) for the caller to map. */
  async createSample(doc: SampleDoc): Promise<void> {
    await this.db.collection(SAMPLES).doc(doc.name).create(doc as any);
  }

  async getSample(name: string): Promise<SampleDoc | null> {
    const snap = await this.db.collection(SAMPLES).doc(name).get();
    return snap.exists ? (snap.data() as SampleDoc) : null;
  }

  async listSamples(): Promise<SampleDoc[]> {
    const snap = await this.db.collection(SAMPLES).get();
    return snap.docs.map((d) => d.data() as SampleDoc);
  }
}
