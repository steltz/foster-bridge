# Per-Contract Data Ingest & Contract-Aware Backtesting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest the per-contract ES candle files from `data/` into per-contract Firestore collections and make the backtest resolve the correct quarterly contract per date, so the benchmark grades every TP day against the contract its levels were quoted on.

**Architecture:** A pure calendar `resolveContract` function (verified roll rule: contract switches on expiration-week Monday) lives in the contracts module; `ContractsService` recognizes quarterly symbols like `ESU26` by deriving from the base ES spec; a detached job endpoint reads the 158 local `data/*.txt` files and writes day-docs to `markets/{contract}/{interval}/{date}` through the existing transactional upsert; `BacktestService` resolves `symbol: 'ES'` + date to a concrete contract and echoes it in the response; the benchmark switches to `ES`/`min-1` at real $50/pt.

**Tech Stack:** NestJS 10, Firestore (firebase-admin), Jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-15-contract-data-ingest-design.md` — read it first; it argues the decisions this plan implements. Background: `docs/es-contract-roll-convention.md`.

## Global Constraints

- Working dir for all commands: `/Users/nicholasstelter/Code/foster-bridge/backend` (tests: `pnpm test -- <pattern>`).
- Quarterly symbol format: `ES` + month code (`H`/`M`/`U`/`Z` = Mar/Jun/Sep/Dec) + 2-digit year, e.g. `ESU26`.
- Candle timestamps are Unix epoch **seconds**; source file wall times are **America/New_York** (ET), DST-aware.
- Day-doc schema is unchanged — OHLC only, volume is parsed-and-dropped.
- Semantic commit messages; no Claude attribution anywhere.
- Out of scope (do NOT build): MES data deletion, prev-day-summary assertion, volume storage, NQ/MNQ quarterly resolution, ingest-job cancellation endpoint.

---

### Task 1: `resolveContract` — the roll rule as a pure function

**Files:**
- Create: `src/contracts/contracts-roll.ts`
- Test: `src/contracts/contracts-roll.spec.ts`

**Interfaces:**
- Produces: `resolveContract(base: 'ES', date: string): string` (e.g. `'ESM26'`); `rollSwitchMonday(year: number, quarterMonth: 3|6|9|12): string` (ISO date, exported for tests).

- [ ] **Step 1: Write the failing test**

`src/contracts/contracts-roll.spec.ts`:

```typescript
import { resolveContract, rollSwitchMonday } from './contracts-roll';

describe('rollSwitchMonday', () => {
  // Expiration = third Friday; switch Monday = third Friday - 4 days.
  it.each([
    [2025, 3, '2025-03-17'],
    [2025, 6, '2025-06-16'],
    [2025, 9, '2025-09-15'],
    [2025, 12, '2025-12-15'],
    [2026, 3, '2026-03-16'],
    [2026, 6, '2026-06-15'],
    [2026, 9, '2026-09-14'],
  ] as const)('(%i, %i) -> %s', (year, month, expected) => {
    expect(rollSwitchMonday(year, month)).toBe(expected);
  });
});

describe('resolveContract', () => {
  // Every verified boundary row from docs/es-contract-roll-convention.md.
  it.each([
    ['2026-03-13', 'ESH26'], // Fri before switch — still front
    ['2026-03-16', 'ESM26'], // switch Monday
    ['2026-06-12', 'ESM26'],
    ['2026-06-15', 'ESU26'],
    ['2025-03-14', 'ESH25'],
    ['2025-03-17', 'ESM25'],
    ['2025-06-09', 'ESM25'],
    ['2025-06-17', 'ESU25'],
    ['2025-09-12', 'ESU25'],
    ['2025-09-16', 'ESZ25'],
    ['2025-12-12', 'ESZ25'],
    ['2025-12-15', 'ESH26'], // Dec rolls into next year's Mar
  ])('%s -> %s', (date, expected) => {
    expect(resolveContract('ES', date)).toBe(expected);
  });

  it('maps non-quarterly months to the next quarterly (Apr -> Jun, Aug -> Sep)', () => {
    expect(resolveContract('ES', '2026-04-10')).toBe('ESM26');
    expect(resolveContract('ES', '2026-08-15')).toBe('ESU26');
  });

  it('handles the Dec -> Mar year boundary on both sides', () => {
    expect(resolveContract('ES', '2025-12-31')).toBe('ESH26');
    expect(resolveContract('ES', '2026-01-02')).toBe('ESH26');
  });

  it('rejects malformed dates', () => {
    expect(() => resolveContract('ES', '06/15/2026')).toThrow('YYYY-MM-DD');
    expect(() => resolveContract('ES', '2026-13-01')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contracts-roll`
Expected: FAIL — cannot find module './contracts-roll'.

- [ ] **Step 3: Write the implementation**

`src/contracts/contracts-roll.ts`:

```typescript
// The verified eminiplayer roll rule (docs/es-contract-roll-convention.md):
// a TP day belongs to the front quarterly until the Monday of expiration
// week (third Friday - 4 days), when it switches to the next quarterly.
// Pure calendar math on ET calendar dates — no I/O, no timezones.

const QUARTER_MONTHS = [3, 6, 9, 12] as const;
type QuarterMonth = (typeof QUARTER_MONTHS)[number];
const MONTH_CODES: Record<QuarterMonth, string> = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function rollSwitchMonday(year: number, quarterMonth: QuarterMonth): string {
  const firstDow = new Date(Date.UTC(year, quarterMonth - 1, 1)).getUTCDay();
  const firstFriday = 1 + ((5 - firstDow + 7) % 7);
  const thirdFriday = firstFriday + 14;
  return isoDate(year, quarterMonth, thirdFriday - 4);
}

export function resolveContract(base: 'ES', date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`resolveContract: date must be YYYY-MM-DD, got "${date}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`resolveContract: invalid date "${date}"`);
  }

  let quarterIndex = QUARTER_MONTHS.findIndex((m) => m >= month);
  let quarterYear = year;
  // month <= 12 always finds an index (12 is the last entry).
  if (date >= rollSwitchMonday(quarterYear, QUARTER_MONTHS[quarterIndex])) {
    quarterIndex += 1;
    if (quarterIndex === QUARTER_MONTHS.length) {
      quarterIndex = 0;
      quarterYear += 1;
    }
  }
  const quarterMonth = QUARTER_MONTHS[quarterIndex];
  return `${base}${MONTH_CODES[quarterMonth]}${String(quarterYear % 100).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- contracts-roll`
Expected: PASS (all rows).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/contracts-roll.ts src/contracts/contracts-roll.spec.ts
git commit -m "feat(contracts): resolveContract implements the verified roll rule"
```

---

### Task 2: Quarterly symbol recognition in `ContractsService`

**Files:**
- Modify: `src/contracts/contracts.service.ts`
- Test: `src/contracts/contracts.service.spec.ts` (append)

**Interfaces:**
- Consumes: static `CONTRACTS` registry (`src/contracts/contracts.constants.ts`).
- Produces: `ContractsService.get('ESU26')` returns the ES spec with `symbol: 'ESU26'`; `has()` unchanged (registry-only). Every service that validates symbols via `get()` (market-data, backtest) now accepts quarterlies with zero further changes.

- [ ] **Step 1: Write the failing test**

Append to `src/contracts/contracts.service.spec.ts`:

```typescript
describe('quarterly contract symbols', () => {
  const svc = new ContractsService();

  it('derives a quarterly spec from the ES base', () => {
    const spec = svc.get('ESU26');
    expect(spec.symbol).toBe('ESU26');
    expect(spec.pointValue).toBe(50);
    expect(spec.tickSize).toBe(0.25);
    expect(spec.timezone).toBe('America/New_York');
    expect(spec.rth).toEqual({ open: '09:30', close: '16:00' });
  });

  it('rejects malformed quarterly-ish symbols', () => {
    for (const bad of ['ESX26', 'ESU2', 'ESU266', 'MESU26', 'esu26']) {
      expect(() => svc.get(bad)).toThrow('Unknown contract symbol');
    }
  });

  it('has() stays registry-only', () => {
    expect(svc.has('ESU26')).toBe(false);
    expect(svc.has('ES')).toBe(true);
  });
});
```

(If the spec file lacks a `ContractsService` import at top, it already constructs the service for existing tests — reuse the same import style found in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contracts.service`
Expected: FAIL — `get('ESU26')` throws NotFoundException.

- [ ] **Step 3: Implement**

In `src/contracts/contracts.service.ts`, replace the `get` method:

```typescript
const QUARTERLY_RE = /^ES[HMUZ]\d{2}$/;

@Injectable()
export class ContractsService {
  get(symbol: string): ContractSpec {
    if (this.has(symbol)) return CONTRACTS[symbol];
    // Quarterly ES contracts (ESH25 ... ESZ27) derive from the ES base spec:
    // same tick, point value, timezone, RTH — only the symbol differs.
    if (QUARTERLY_RE.test(symbol)) return { ...CONTRACTS.ES, symbol };
    throw new NotFoundException(`Unknown contract symbol: ${symbol}`);
  }
  has(symbol: string): boolean {
    return Object.prototype.hasOwnProperty.call(CONTRACTS, symbol);
  }
  list(): ContractSpec[] {
    return Object.values(CONTRACTS);
  }
}
```

(`QUARTERLY_RE` is a module-level const above the class. `NotFoundException` import already exists.)

- [ ] **Step 4: Run tests**

Run: `pnpm test -- contracts.service`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/contracts.service.ts src/contracts/contracts.service.spec.ts
git commit -m "feat(contracts): recognize quarterly ES symbols, deriving from the base spec"
```

---

### Task 3: Contract txt parser with ET-wall-time conversion

**Files:**
- Create: `src/market-data/contract-txt-parser.ts`
- Test: `src/market-data/contract-txt-parser.spec.ts`

**Interfaces:**
- Consumes: `Candle` from `src/market-data/candle.ts`.
- Produces: `parseContractTxt(text: string): Candle[]` — throws `Error` with line context on any malformed row (all-or-nothing per file); `etWallTimeToEpochSeconds(y, mo, d, h, mi, s): number` (exported for tests).

- [ ] **Step 1: Write the failing test**

`src/market-data/contract-txt-parser.spec.ts`:

```typescript
import { etWallTimeToEpochSeconds, parseContractTxt } from './contract-txt-parser';

describe('etWallTimeToEpochSeconds', () => {
  it('converts EST wall time (UTC-5)', () => {
    // 2026-01-15 10:00:00 ET == 15:00 UTC
    expect(etWallTimeToEpochSeconds(2026, 1, 15, 10, 0, 0)).toBe(Date.UTC(2026, 0, 15, 15, 0, 0) / 1000);
  });

  it('converts EDT wall time (UTC-4)', () => {
    // 2026-07-15 10:00:00 ET == 14:00 UTC
    expect(etWallTimeToEpochSeconds(2026, 7, 15, 10, 0, 0)).toBe(Date.UTC(2026, 6, 15, 14, 0, 0) / 1000);
  });

  it('is correct across the spring-forward transition (2026-03-08)', () => {
    // 01:59 ET is still EST (UTC-5); 03:00 ET is EDT (UTC-4).
    expect(etWallTimeToEpochSeconds(2026, 3, 8, 1, 59, 0)).toBe(Date.UTC(2026, 2, 8, 6, 59, 0) / 1000);
    expect(etWallTimeToEpochSeconds(2026, 3, 8, 3, 0, 0)).toBe(Date.UTC(2026, 2, 8, 7, 0, 0) / 1000);
  });
});

describe('parseContractTxt', () => {
  it('parses headerless datetime rows, dropping volume, sorted by time', () => {
    const text = [
      '2026-06-15 09:35:00,7500.25,7501.0,7499.5,7500.0,321',
      '2026-06-15 09:30:00,7498.0,7500.5,7497.75,7500.25,955',
      '',
    ].join('\n');
    const candles = parseContractTxt(text);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: etWallTimeToEpochSeconds(2026, 6, 15, 9, 30, 0),
      open: 7498.0, high: 7500.5, low: 7497.75, close: 7500.25,
    });
    expect(candles[1].time).toBeGreaterThan(candles[0].time);
  });

  it('rejects a malformed row with line context', () => {
    const text = [
      '2026-06-15 09:30:00,7498.0,7500.5,7497.75,7500.25,955',
      '2026-06-15 09:35:00,notanumber,7501.0,7499.5,7500.0,321',
    ].join('\n');
    expect(() => parseContractTxt(text)).toThrow('line 2');
  });

  it('rejects rows without the expected shape', () => {
    expect(() => parseContractTxt('time,open,high,low,close\n123,1,2,3,4')).toThrow('line 1');
  });

  it('rejects empty input', () => {
    expect(() => parseContractTxt('\n\n')).toThrow('no data rows');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contract-txt-parser`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/market-data/contract-txt-parser.ts`:

```typescript
import { Candle } from './candle';

// Parses the local per-contract export format: headerless lines of
//   YYYY-MM-DD HH:MM:SS,open,high,low,close,volume
// with ET-naive wall times. Volume is parsed-and-dropped (day-docs are
// OHLC-only; the files on disk remain the volume source). Any malformed
// row fails the whole file — reject, don't guess.

const ROW_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+)$/;

const ET = 'America/New_York';
const etFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

// Offset (ms) such that: wall-clock-in-ET-as-if-UTC == epochMs + offset.
function etOffsetAt(epochMs: number): number {
  const parts = etFmt.formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - epochMs;
}

export function etWallTimeToEpochSeconds(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes converge on the correct offset across DST transitions.
  let epoch = utcGuess - etOffsetAt(utcGuess);
  epoch = utcGuess - etOffsetAt(epoch);
  return epoch / 1000;
}

export function parseContractTxt(text: string): Candle[] {
  const lines = text.split(/\r?\n/);
  const candles: Candle[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const m = ROW_RE.exec(line);
    if (!m) throw new Error(`contract txt line ${i + 1}: unexpected row shape "${line.slice(0, 60)}"`);
    const [open, high, low, close] = [m[7], m[8], m[9], m[10]].map(Number);
    const volume = Number(m[11]);
    if (![open, high, low, close, volume].every(Number.isFinite)) {
      throw new Error(`contract txt line ${i + 1}: non-numeric OHLCV value`);
    }
    candles.push({
      time: etWallTimeToEpochSeconds(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
      open, high, low, close,
    });
  }
  if (candles.length === 0) throw new Error('contract txt has no data rows');
  candles.sort((a, b) => a.time - b.time);
  return candles;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- contract-txt-parser`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/market-data/contract-txt-parser.ts src/market-data/contract-txt-parser.spec.ts
git commit -m "feat(market-data): parser for headerless ET-naive contract txt files"
```

---

### Task 4: Extract `ingestCandles` from `ingestCsv`

**Files:**
- Modify: `src/market-data/market-data.service.ts`
- Test: `src/market-data/market-data.service.spec.ts` (append)

**Interfaces:**
- Consumes: existing private `upsertDay`, `validate`.
- Produces: `MarketDataService.ingestCandles(symbol: string, interval: Interval, candles: Candle[], opts: IngestOptions): Promise<IngestSummary>` — public; `ingestCsv` becomes parse-then-delegate. Task 5's job service calls `ingestCandles` directly.

- [ ] **Step 1: Write the failing test**

Append to `src/market-data/market-data.service.spec.ts` (reuse the file's existing fake-Firestore builder and service construction pattern — the test body below is what matters):

```typescript
describe('ingestCandles', () => {
  it('accepts pre-parsed candles and produces the same summary as ingestCsv', async () => {
    // Same construction as the existing ingest tests in this file.
    const svc = buildService(); // <- use whatever helper/pattern the file already uses
    const candles = [
      { time: 1750000200, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 1750000500, open: 1.5, high: 2.5, low: 1.0, close: 2.0 },
    ];
    const summary = await svc.ingestCandles('ESU26', 'min-5', candles, {});
    expect(summary.symbol).toBe('ESU26');
    expect(summary.totalRows).toBe(2);
    expect(summary.days).toHaveLength(1);
  });

  it('rejects candles misaligned to the interval grid', async () => {
    const svc = buildService();
    await expect(
      svc.ingestCandles('ESU26', 'min-5', [{ time: 1750000201, open: 1, high: 1, low: 1, close: 1 }], {}),
    ).rejects.toThrow('not aligned');
  });
});
```

Note for the implementer: `1750000200 % 300 === 0` must hold — if you change the timestamps, keep them on the 5-minute grid (and the misaligned one off it).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- market-data.service`
Expected: FAIL — `ingestCandles` is not a function.

- [ ] **Step 3: Implement by extraction**

In `src/market-data/market-data.service.ts`, split `ingestCsv` — the CSV-specific part stays, everything after parsing moves into the new public method:

```typescript
async ingestCsv(symbol: string, interval: Interval, csvText: string, opts: IngestOptions): Promise<IngestSummary> {
  this.validate(symbol, interval);
  let candles: Candle[];
  try {
    candles = parseCsv(csvText);
  } catch (err) {
    throw new BadRequestException((err as Error).message);
  }
  return this.ingestCandles(symbol, interval, candles, opts);
}

async ingestCandles(symbol: string, interval: Interval, candles: Candle[], opts: IngestOptions): Promise<IngestSummary> {
  this.validate(symbol, interval);
  const spec = this.contracts.get(symbol);

  // Reject mislabeled inputs: every candle must sit on the interval grid.
  const intervalSec = intervalToSeconds(interval);
  const misaligned = candles.find((c) => c.time % intervalSec !== 0);
  if (misaligned) {
    throw new BadRequestException(
      `Candle time ${misaligned.time} is not aligned to the ${interval} interval ` +
        `(${intervalSec}s); the data does not match this interval`,
    );
  }

  // Group by ET calendar day.
  const byDay = new Map<string, Candle[]>();
  for (const c of candles) {
    const date = dateForTimestamp(c.time, spec.timezone);
    const list = byDay.get(date) ?? [];
    list.push(c);
    byDay.set(date, list);
  }

  const window = {
    openMin: hhmmToMinutes(spec.rth.open),
    closeMin: hhmmToMinutes(spec.rth.close),
    intervalSec,
    tz: spec.timezone,
  };

  const days: DayIngestResult[] = [];
  for (const [date, dayCandles] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    days.push(await this.upsertDay(symbol, interval, date, dayCandles.map(toStored), window, opts.replace === true));
  }
  return { symbol, interval, totalRows: candles.length, days };
}
```

(The double `validate` call is harmless — idempotent check. The one wording change: "the data does not match this interval" instead of "the CSV…", since the caller may not be CSV; existing tests asserting on `'not aligned'` substrings still pass.)

- [ ] **Step 4: Run the full market-data suite**

Run: `pnpm test -- market-data`
Expected: PASS — new tests and all pre-existing ingestCsv tests.

- [ ] **Step 5: Commit**

```bash
git add src/market-data/market-data.service.ts src/market-data/market-data.service.spec.ts
git commit -m "refactor(market-data): extract ingestCandles for non-CSV ingest paths"
```

---

### Task 5: Contract ingest job — service, controller, wiring

**Files:**
- Create: `src/market-data/contract-ingest.service.ts`
- Create: `src/market-data/contract-ingest.controller.ts`
- Modify: `src/market-data/market-data.module.ts` (provide/export the service)
- Modify: `src/app.module.ts` (register the controller)
- Test: `src/market-data/contract-ingest.service.spec.ts`

**Interfaces:**
- Consumes: `MarketDataService.ingestCandles` (Task 4), `parseContractTxt` (Task 3), config key `benchmark.repoRoot`.
- Produces: `POST /markets/ingest-contracts` (202; 409 if running), `GET /markets/ingest-contracts` (snapshot; `{ state: 'idle' }` if never run). `ContractIngestService.start(): ContractIngestSnapshot`, `snapshot(): ContractIngestSnapshot | null`, test seam `loopPromise`.

- [ ] **Step 1: Write the failing test**

`src/market-data/contract-ingest.service.spec.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ContractIngestService, ContractIngestAlreadyRunningError, mapContractFile } from './contract-ingest.service';

describe('mapContractFile', () => {
  it.each([
    ['ES_U26_1min.txt', { symbol: 'ESU26', interval: 'min-1' }],
    ['ES_H25_5min.txt', { symbol: 'ESH25', interval: 'min-5' }],
  ] as const)('%s -> %o', (name, expected) => {
    expect(mapContractFile(name)).toEqual(expected);
  });

  it('returns null for non-matching names', () => {
    expect(mapContractFile('README.md')).toBeNull();
    expect(mapContractFile('ES_X26_1min.txt')).toBeNull();
    expect(mapContractFile('NQ_U26_1min.txt')).toBeNull();
  });
});

describe('ContractIngestService', () => {
  let root: string;
  const ingested: { symbol: string; interval: string; count: number }[] = [];
  const marketData = {
    ingestCandles: jest.fn(async (symbol: string, interval: string, candles: unknown[]) => {
      ingested.push({ symbol, interval, count: candles.length });
      return { symbol, interval, totalRows: candles.length, days: [{ date: '2026-06-15', added: candles.length, updated: 0, unchanged: false, totalAfter: candles.length, complete: false }] };
    }),
  };

  function build(): ContractIngestService {
    const config = { get: (key: string) => (key === 'benchmark.repoRoot' ? root : undefined) } as unknown as ConfigService;
    return new ContractIngestService(marketData as never, config);
  }

  beforeEach(() => {
    ingested.length = 0;
    marketData.ingestCandles.mockClear();
    root = mkdtempSync(join(tmpdir(), 'contract-ingest-'));
    // archive processed before update: same-named contract in update must win last-write.
    for (const dir of ['ES_5min_archive_t6h13g', 'ES_5min_update_t6h13g']) {
      mkdirSync(join(root, 'data', dir), { recursive: true });
    }
    writeFileSync(
      join(root, 'data', 'ES_5min_archive_t6h13g', 'ES_M25_5min.txt'),
      '2025-06-02 09:30:00,6000,6001,5999,6000.5,10\n',
    );
    writeFileSync(
      join(root, 'data', 'ES_5min_update_t6h13g', 'ES_U26_5min.txt'),
      '2026-06-15 09:30:00,7500,7501,7499,7500.5,10\n2026-06-15 09:35:00,7500.5,7502,7500,7501,12\n',
    );
    writeFileSync(join(root, 'data', 'ES_5min_update_t6h13g', 'notes.txt'), 'not a contract file\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('walks dirs (archive first), maps files, ingests, and reports per-file results', async () => {
    const svc = build();
    const snap = svc.start();
    expect(snap.state).toBe('running');
    await svc.loopPromise;

    const done = svc.snapshot()!;
    expect(done.state).toBe('done');
    expect(done.counts.files).toBe(2); // notes.txt skipped, not counted as a contract file
    expect(done.counts.processed).toBe(2);
    expect(done.counts.failed).toBe(0);
    expect(done.skipped).toContain('ES_5min_update_t6h13g/notes.txt');
    // Archive before update.
    expect(ingested.map((r) => r.symbol)).toEqual(['ESM25', 'ESU26']);
    expect(ingested[1]).toEqual({ symbol: 'ESU26', interval: 'min-5', count: 2 });
  });

  it('isolates a file failure and continues', async () => {
    writeFileSync(join(root, 'data', 'ES_5min_archive_t6h13g', 'ES_H25_5min.txt'), 'garbage row\n');
    const svc = build();
    svc.start();
    await svc.loopPromise;
    const done = svc.snapshot()!;
    expect(done.state).toBe('done');
    expect(done.counts.failed).toBe(1);
    const failed = done.results.find((r) => r.file.endsWith('ES_H25_5min.txt'))!;
    expect(failed.error).toContain('line 1');
    // The good files still ingested (ESH25 failed at parse, so it never
    // reached ingestCandles; processed counts attempts, failed the subset).
    expect(done.counts.processed).toBe(3);
    expect(ingested.map((r) => r.symbol)).toEqual(['ESM25', 'ESU26']);
  });

  it('409s a second start while running', async () => {
    const svc = build();
    svc.start();
    expect(() => svc.start()).toThrow(ContractIngestAlreadyRunningError);
    await svc.loopPromise;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contract-ingest`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

`src/market-data/contract-ingest.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MarketDataService } from './market-data.service';
import { parseContractTxt } from './contract-txt-parser';
import { Interval } from './candle';

// Detached one-shot job that walks the repo's data/ dirs and ingests every
// per-contract txt file into markets/{contract}/{interval}. Mirrors the
// eminiplayer backfill's in-memory job pattern, minus cancellation (the job
// is local-disk + Firestore and safely re-runnable; upserts are idempotent).

const FILE_RE = /^ES_([HMUZ]\d{2})_(1min|5min)\.txt$/;
const INTERVAL_BY_SUFFIX: Record<string, Interval> = { '1min': 'min-1', '5min': 'min-5' };

// Archive dirs FIRST: where a contract appears in both, update (fresher) wins
// last-write in the per-candle merge.
const DATA_DIRS = [
  'ES_1min_archive_t6h13g',
  'ES_5min_archive_t6h13g',
  'ES_1min_update_t6h13g',
  'ES_5min_update_t6h13g',
];

export function mapContractFile(name: string): { symbol: string; interval: Interval } | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return { symbol: `ES${m[1]}`, interval: INTERVAL_BY_SUFFIX[m[2]] };
}

export interface ContractIngestFileResult {
  file: string; // relative to data/, e.g. 'ES_5min_update_t6h13g/ES_U26_5min.txt'
  contract: string;
  interval: Interval;
  days: number;
  added: number;
  updated: number;
  error?: string;
}

export interface ContractIngestSnapshot {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  currentFile: string | null;
  counts: { files: number; processed: number; failed: number };
  results: ContractIngestFileResult[];
  /** Non-contract files encountered in the data dirs (relative paths). */
  skipped: string[];
  error: string | null;
}

export class ContractIngestAlreadyRunningError extends Error {
  constructor() {
    super('a contract ingest job is already running');
  }
}

@Injectable()
export class ContractIngestService {
  private readonly logger = new Logger(ContractIngestService.name);
  private job: ContractIngestSnapshot | null = null;
  /** Test seam: the detached loop, awaitable. */
  loopPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly marketData: MarketDataService,
    private readonly config: ConfigService,
  ) {}

  snapshot(): ContractIngestSnapshot | null {
    return this.job;
  }

  start(): ContractIngestSnapshot {
    if (this.job?.state === 'running') throw new ContractIngestAlreadyRunningError();
    const dataRoot = join(this.config.get<string>('benchmark.repoRoot')!, 'data');

    const files: { rel: string; abs: string; symbol: string; interval: Interval }[] = [];
    const skipped: string[] = [];
    for (const dir of DATA_DIRS) {
      const abs = join(dataRoot, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs).sort()) {
        const mapped = mapContractFile(name);
        if (!mapped) {
          skipped.push(`${dir}/${name}`);
          continue;
        }
        files.push({ rel: `${dir}/${name}`, abs: join(abs, name), ...mapped });
      }
    }

    this.job = {
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentFile: null,
      counts: { files: files.length, processed: 0, failed: 0 },
      results: [],
      skipped,
      error: null,
    };
    this.loopPromise = this.run(files).catch((err) => {
      this.job!.state = 'failed';
      this.job!.error = (err as Error).message;
      this.job!.finishedAt = new Date().toISOString();
    });
    return this.job;
  }

  private async run(files: { rel: string; abs: string; symbol: string; interval: Interval }[]): Promise<void> {
    const job = this.job!;
    for (const f of files) {
      job.currentFile = f.rel;
      try {
        const candles = parseContractTxt(readFileSync(f.abs, 'utf8'));
        const summary = await this.marketData.ingestCandles(f.symbol, f.interval, candles, {});
        job.results.push({
          file: f.rel,
          contract: f.symbol,
          interval: f.interval,
          days: summary.days.length,
          added: summary.days.reduce((n, d) => n + d.added, 0),
          updated: summary.days.reduce((n, d) => n + d.updated, 0),
        });
      } catch (err) {
        job.counts.failed += 1;
        job.results.push({
          file: f.rel, contract: f.symbol, interval: f.interval,
          days: 0, added: 0, updated: 0, error: (err as Error).message,
        });
        this.logger.warn(`ingest failed for ${f.rel}: ${(err as Error).message}`);
      }
      job.counts.processed += 1;
    }
    job.currentFile = null;
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
  }
}
```

Note: the second spec test asserts `processed` counts failed files too — `processed` means "attempted", `failed` is the subset that errored. The `expect(ingested...)` line in that test filters out the failed contract because `ingestCandles` is never reached for a file that fails parsing.

- [ ] **Step 4: Run the service tests**

Run: `pnpm test -- contract-ingest`
Expected: PASS.

- [ ] **Step 5: Implement the controller**

`src/market-data/contract-ingest.controller.ts`:

```typescript
import { ConflictException, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ContractIngestAlreadyRunningError, ContractIngestService } from './contract-ingest.service';

@Controller('markets')
export class ContractIngestController {
  constructor(private readonly ingest: ContractIngestService) {}

  @Post('ingest-contracts')
  @HttpCode(202)
  start() {
    try {
      return this.ingest.start();
    } catch (err) {
      if (err instanceof ContractIngestAlreadyRunningError) throw new ConflictException(err.message);
      throw err;
    }
  }

  @Get('ingest-contracts')
  status() {
    return this.ingest.snapshot() ?? { state: 'idle' };
  }
}
```

(No route conflict with `MarketDataController`: its routes are all under `markets/:symbol/:interval/...` — 3+ path segments — while these are 2-segment routes.)

- [ ] **Step 6: Wire the module and app**

`src/market-data/market-data.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { ContractIngestService } from './contract-ingest.service';

@Module({
  providers: [MarketDataService, ContractIngestService],
  exports: [MarketDataService, ContractIngestService],
})
export class MarketDataModule {}
```

In `src/app.module.ts`: add `import { ContractIngestController } from './market-data/contract-ingest.controller';` next to the MarketDataController import (line ~22) and add `ContractIngestController,` to the `controllers` array after `MarketDataController,` (line ~48).

- [ ] **Step 7: Run the whole backend suite**

Run: `pnpm test`
Expected: PASS across the board (module wiring specs included — if an app-module spec asserts the controller list, update it to include `ContractIngestController`).

- [ ] **Step 8: Commit**

```bash
git add src/market-data/contract-ingest.service.ts src/market-data/contract-ingest.service.spec.ts src/market-data/contract-ingest.controller.ts src/market-data/market-data.module.ts src/app.module.ts
git commit -m "feat(market-data): detached job ingesting per-contract txt files into Firestore"
```

---

### Task 6: Backtest contract resolution

**Files:**
- Modify: `src/execution/backtest.service.ts`
- Test: `src/execution/backtest.service.spec.ts` (append)

**Interfaces:**
- Consumes: `resolveContract` (Task 1), quarterly `get()` (Task 2).
- Produces: `BacktestResult` gains `contract: string`; `run({ symbol: 'ES', ... })` reads the resolved contract's candles. Task 7 relies on `symbol: 'ES'` resolving per-date.

- [ ] **Step 1: Write the failing test**

Append to `src/execution/backtest.service.spec.ts` (reuse the file's existing service/mocks construction pattern; the essential assertions):

```typescript
describe('contract resolution', () => {
  it("resolves symbol 'ES' to the front contract and echoes it", async () => {
    // Arrange the market-data mock to hold candles under 'ESM26' for 2026-06-12.
    // (Same candle fixture the file's existing happy-path test uses.)
    const result = await service.run({ ...baseRequest, symbol: 'ES', date: '2026-06-12' });
    expect(result.contract).toBe('ESM26');
    expect(result.symbol).toBe('ES');
    expect(marketDataMock.getDay).toHaveBeenCalledWith('ESM26', baseRequest.interval, '2026-06-12');
  });

  it('resolves to the next quarterly on/after the switch Monday', async () => {
    // Candles under 'ESU26' for 2026-06-15.
    const result = await service.run({ ...baseRequest, symbol: 'ES', date: '2026-06-15' });
    expect(result.contract).toBe('ESU26');
    expect(marketDataMock.getDay).toHaveBeenCalledWith('ESU26', baseRequest.interval, '2026-06-15');
  });

  it('explicit quarterly symbols bypass resolution', async () => {
    const result = await service.run({ ...baseRequest, symbol: 'ESM26', date: '2026-06-15' });
    expect(result.contract).toBe('ESM26');
    expect(marketDataMock.getDay).toHaveBeenCalledWith('ESM26', baseRequest.interval, '2026-06-15');
  });

  it('non-resolved symbols behave exactly as before, contract === symbol', async () => {
    const result = await service.run({ ...baseRequest, symbol: 'MES', date: '2026-06-15' });
    expect(result.contract).toBe('MES');
    expect(marketDataMock.getDay).toHaveBeenCalledWith('MES', baseRequest.interval, '2026-06-15');
  });

  it('404 for a resolved-but-missing day names the contract', async () => {
    // getDay mock returns null for 'ESU26'.
    await expect(service.run({ ...baseRequest, symbol: 'ES', date: '2026-06-15' })).rejects.toThrow('ESU26');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- backtest.service`
Expected: FAIL — `result.contract` is undefined; `getDay` called with `'ES'`.

- [ ] **Step 3: Implement**

In `src/execution/backtest.service.ts`:

1. Import: `import { resolveContract } from '../contracts/contracts-roll';`
2. Module-level const above the class: `const ROLL_RESOLVED_BASES = new Set(['ES']);`
3. Add to `BacktestResult`: `contract: string;` (after `symbol`).
4. In `run`, after the date-format validation (the `/^\d{4}-\d{2}-\d{2}$/` check) and before session validation, insert:

```typescript
// A roll-resolved base (ES) maps date -> concrete quarterly per the
// verified roll rule; explicit contract symbols and every other symbol
// pass through untouched. The spec is identical by derivation, so
// pointValue/RTH math is unaffected.
const contract = ROLL_RESOLVED_BASES.has(req.symbol) ? resolveContract('ES', req.date) : req.symbol;
```

5. Change the candle read to use `contract`:

```typescript
const dayCandles = await this.marketData.getDay(contract, req.interval, req.date);
if (dayCandles === null || dayCandles.length === 0) {
  throw new NotFoundException(`No stored candle data for ${contract} ${req.interval} ${req.date}`);
}
```

6. Also use `contract` in the incomplete-session error message (`Incomplete RTH session for ${contract} ${req.date}...`).
7. Return: `return { symbol: req.symbol, contract, date: req.date, session, results, summary, coverage };`

- [ ] **Step 4: Run the execution suite**

Run: `pnpm test -- execution`
Expected: PASS — new tests plus all pre-existing backtest tests (they use `MES`/`NQ`-style symbols, whose behavior is unchanged; if any assert an exact result-object shape, add `contract: <symbol>` to the expectation).

- [ ] **Step 5: Commit**

```bash
git add src/execution/backtest.service.ts src/execution/backtest.service.spec.ts
git commit -m "feat(execution): backtest resolves ES quarterly contract per date"
```

---

### Task 7: Benchmark switches to ES / min-1

**Files:**
- Modify: `src/benchmark/batch-reconciler.ts:14-15`
- Modify: `src/benchmark/benchmark.service.ts:23-24` and its per-day `getDay` call (~line 170)
- Test: existing `src/benchmark/*.spec.ts` updated expectations

**Interfaces:**
- Consumes: `resolveContract` (Task 1); backtest auto-resolution (Task 6).
- Produces: benchmark grades against `ES`/`min-1` at $50/pt.

- [ ] **Step 1: Flip the constants**

In `src/benchmark/batch-reconciler.ts`:

```typescript
const SYMBOL = 'ES';
const INTERVAL = 'min-1' as const;
```

In `src/benchmark/benchmark.service.ts`:

```typescript
const SYMBOL = 'ES';
const INTERVAL = 'min-1' as const;
```

The reconciler's `backtest.run({ symbol: SYMBOL, ... })` now auto-resolves per date (Task 6) — no further reconciler changes.

- [ ] **Step 2: Fix the direct store reads in benchmark.service.ts**

`benchmark.service.ts` reads candles directly (`this.marketData.getDay(SYMBOL, INTERVAL, day.date)` in the day loop, ~line 170) as a prerequisite/coverage check. A direct store read does NOT go through backtest resolution, so it must resolve itself. Add the import:

```typescript
import { resolveContract } from '../contracts/contracts-roll';
```

and change the read inside the day loop:

```typescript
const daySymbol = resolveContract('ES', day.date);
const candles = await this.marketData.getDay(daySymbol, INTERVAL, day.date);
```

The `spec`/`rthWindow` computed from `this.contracts.get(SYMBOL)` above the loop stays as-is — the quarterly spec is identical to the base by derivation.

- [ ] **Step 3: Run the benchmark suite and fix expectations**

Run: `pnpm test -- benchmark`
Expected: failures only in specs that hard-code `'MES'`/`'min-5'` expectations (e.g. asserting `getDay` call args or backtest request shapes). Update those expectations to `ES`-resolved contracts / `min-1`. Do not weaken assertions — update the expected literals.

- [ ] **Step 4: Full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/batch-reconciler.ts src/benchmark/benchmark.service.ts src/benchmark
git commit -m "feat(benchmark): grade against per-contract ES min-1 data at real ES economics"
```

---

### Task 8: Run the ingest and verify end-to-end

No new code — the rollout from the spec, executed and verified. Requires GCP ADC credentials (already configured for the dev backend).

- [ ] **Step 1: Start the backend**

```bash
cd /Users/nicholasstelter/Code/foster-bridge/backend && pnpm start:dev
```

Wait for `GET http://localhost:3000/health/ready` → `{"status":"ok",...}`.

- [ ] **Step 2: Kick off the ingest**

```bash
curl -s -X POST http://localhost:3000/markets/ingest-contracts
```

Expected: 202 with `state: "running"`, `counts.files: 158` (79 contracts × 2 intervals; count may differ slightly if data dirs change — the point is all four dirs are walked).

- [ ] **Step 3: Poll until done**

```bash
curl -s http://localhost:3000/markets/ingest-contracts | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['state'], d['counts'])"
```

Expected: eventually `done` with `failed: 0`. This is a large job (~535MB, order 10⁴–10⁵ day-docs) — expect tens of minutes. Any failed file: inspect `results[].error`, fix, re-POST (idempotent; unchanged days no-op).

- [ ] **Step 4: Spot-check stored data**

```bash
# The liquid window of ESU26 shows complete RTH days:
curl -s "http://localhost:3000/markets/ESU26/min-1/days" | python3 -c "
import json,sys
days=json.load(sys.stdin)
complete=[d for d in days if d['complete']]
print('days:', len(days), 'complete:', len(complete), 'first complete:', complete[0]['date'] if complete else None)"
```

Expected: complete days exist and start around the Jun 2026 roll (2026-06-15 ±).

- [ ] **Step 5: Verify a known boundary backtest resolves correctly**

```bash
# 2026-06-12 must run against ESM26; 2026-06-15 against ESU26.
curl -s -X POST http://localhost:3000/backtest -H 'Content-Type: application/json' -d '{
  "symbol": "ES", "interval": "min-1", "date": "2026-06-15", "session": "rth",
  "orders": [{ "side": "long", "entry": 7500, "stopLoss": 7490, "takeProfit": 7520, "qty": 1 }]
}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('contract:', d.get('contract'), 'summary:', d.get('summary'))"
```

Expected: `contract: ESU26` and a real simulation summary (order details don't matter — the resolution echo does).

- [ ] **Step 6: Update the roll-convention doc's status**

In `docs/es-contract-roll-convention.md`, replace the "Planned implementation (not yet built)" heading with "Implementation" and note: resolveContract lives in `backend/src/contracts/contracts-roll.ts`; the prev-day assertion remains a follow-up.

- [ ] **Step 7: Commit**

```bash
git add docs/es-contract-roll-convention.md
git commit -m "docs: roll-convention doc points at the shipped resolveContract"
```
