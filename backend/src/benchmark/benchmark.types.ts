// Domain types for the trader-bench backend port. Core-pipeline scope:
// `base` and `seven-keys-method` only. Seven-keys generation and the
// `seven-keys-scorecard` variant are Plan 2.

export type Side = 'long' | 'short';

export interface Setup {
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rationale: string;
  primaryZone: string;
  confidence: number; // integer 1-5
  rejectedAlternative?: string;
}

// JSON schema for structured output (output_config.format). NOTE: the
// structured-outputs validator rejects string maxLength and integer
// minimum/maximum, and the raw batch path does not strip them, so those
// constraints are DELIBERATELY omitted here — only type/enum/required/
// additionalProperties are sent. The reconciler re-validates ranges (confidence
// 1..5) and side/numeric fields itself (Task 10 buildCell).
export const SETUP_SCHEMA = {
  type: 'object',
  required: ['side', 'entry', 'stopLoss', 'takeProfit', 'rationale', 'primaryZone', 'confidence'],
  properties: {
    side: { enum: ['long', 'short'] },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    rationale: { type: 'string' },
    primaryZone: { type: 'string' },
    confidence: { type: 'integer' },
    rejectedAlternative: { type: 'string' },
  },
  additionalProperties: false,
} as const;

// TP/SL/EOD/NOT_FILLED come straight from the engine. Bench-only statuses:
// INVALID (bad prices / order geometry the judge rejects), NO_SETUP (refusal /
// dead result), and CLI_ERROR (backtest failed for an environmental reason —
// missing candles, incomplete session — not the setup's fault).
export type CellStatus = 'TP' | 'SL' | 'EOD' | 'NOT_FILLED' | 'INVALID' | 'NO_SETUP' | 'CLI_ERROR';

export type Variant = string; // 'base' | 'seven-keys-method' | 'seven-keys-scorecard'
export const CORE_VARIANTS: readonly Variant[] = Object.freeze(['base', 'seven-keys-method']);
// Plan 2: the generated-artifact variant. Kept OUT of CORE_VARIANTS (base/method-only
// callers must not pick it up); ALL_VARIANTS is the full set the run accepts.
export const SCORECARD_VARIANT: Variant = 'seven-keys-scorecard';
export const ALL_VARIANTS: readonly Variant[] = Object.freeze([...CORE_VARIANTS, SCORECARD_VARIANT]);

export interface CellResult {
  status: CellStatus;
  points?: number | null;
  dollars?: number | null;
  fillTime?: number | null;
  exitTime?: number | null;
  maxAdverseExcursion?: number | null;
  maxFavorableExcursion?: number | null;
  rMultiple?: number | null;
  closestApproach?: number | null;
}

export interface BenchmarkCell {
  trader: string;
  model: { alias: string; id: string };
  // Flat mirror of model.alias so the Firestore fake (top-level fields only)
  // can filter on it; model.{alias,id} is what the scoreboard reads.
  modelAlias: string;
  day: string; // MMDDYYYY (cell directory key / chronology source)
  date: string; // YYYY-MM-DD (backtest date)
  variant: Variant;
  runIndex: number;
  personaSha256: string;
  generalSha256: string;
  featureSha256?: string; // omitted for base
  staticDocSha256?: string; // omitted when the variant has no staticDoc
  artifactSha256?: string; // sha256 of the injected KEYS content (scorecard cells only)
  setup?: Setup;
  result: CellResult;
  note?: string;
  createdAt: string; // ISO-8601 UTC
}

export interface CellKeyParts {
  trader: string;
  modelAlias: string;
  day: string;
  variant: Variant;
  runIndex: number;
}

// Doc id: {trader}__{alias}__{day}__{variant}__run{N}. No field contains "__":
// trader/variant are slugs, alias is a short alias, day is 8 digits.
export function cellKey(p: CellKeyParts): string {
  return `${p.trader}__${p.modelAlias}__${p.day}__${p.variant}__run${p.runIndex}`;
}

export function parseCellKey(id: string): CellKeyParts {
  const parts = id.split('__');
  if (parts.length !== 5 || !parts[4].startsWith('run')) {
    throw new Error(`Malformed cell key: ${id}`);
  }
  const [trader, modelAlias, day, variant, runField] = parts;
  const runIndex = parseInt(runField.slice(3), 10);
  if (!Number.isInteger(runIndex) || runIndex < 1) {
    throw new Error(`Malformed cell key: ${id}`);
  }
  return { trader, modelAlias, day, variant, runIndex };
}

export const MODEL_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

// Accepts an alias ('fable') or a raw id ('claude-fable-5'); returns both.
// Unknown values pass through as alias === id so a new model needs no code change.
// Object.assign attaches ALIASES as a type-safe property callers can read.
export const resolveModel = Object.assign(
  (value: string): { alias: string; id: string } => {
    if (MODEL_ALIASES[value]) return { alias: value, id: MODEL_ALIASES[value] };
    const alias = Object.keys(MODEL_ALIASES).find((a) => MODEL_ALIASES[a] === value);
    if (alias) return { alias, id: value };
    return { alias: value, id: value };
  },
  { ALIASES: MODEL_ALIASES },
);
