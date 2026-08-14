import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { BenchmarkCell, cellKey, SCORECARD_VARIANT } from './benchmark.types';

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

export interface ScoreboardDoc {
  json: unknown;
  markdown: string;
  generatedAt: string;
}

const RUNS = 'benchmarkRuns';
const BATCHES = 'benchmarkBatches';
const ARTIFACTS = 'dayArtifacts';
const SCOREBOARD = 'benchmarkScoreboard';

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

  // True once the day has at least one persisted seven-keys-scorecard cell. Such a
  // cell pinned this day's KEYS via artifactSha256, so ensureKeys must treat the
  // stored artifact as immutable from then on.
  async hasScorecardCells(day: string): Promise<boolean> {
    const snap = await this.db
      .collection(RUNS)
      .where('day', '==', day)
      .where('variant', '==', SCORECARD_VARIANT)
      .get();
    return snap.docs.length > 0;
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

  async getScoreboard(modelAlias: string): Promise<ScoreboardDoc | null> {
    const snap = await this.db.collection(SCOREBOARD).doc(modelAlias).get();
    return snap.exists ? (snap.data() as ScoreboardDoc) : null;
  }

  async saveScoreboard(modelAlias: string, doc: ScoreboardDoc): Promise<void> {
    await this.db.collection(SCOREBOARD).doc(modelAlias).set(doc as any);
  }
}
