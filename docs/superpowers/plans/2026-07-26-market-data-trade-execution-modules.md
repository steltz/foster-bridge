# Market-Data + Trade-Execution NestJS Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the CLI's pure trade-execution engine into the NestJS backend and add a Firestore-backed, multi-contract OHLC market-data model with idempotent CSV ingest and a coverage gate that blocks backtests on incomplete session data.

**Architecture:** Three new folders under `backend/src/` — `contracts/` (static registry), `market-data/` (Firestore day-doc store + CSV ingest + coverage util), `execution/` (pure engine + `BacktestService` orchestration + endpoint) — plus shared pure time helpers in `common/`. The engine stays a set of pure functions (heavily unit-tested); services inject `FIRESTORE` and are tested with a fake Firestore. The existing CLI under `src/` is left untouched.

**Tech Stack:** NestJS 10, TypeScript (CommonJS, `strictNullChecks`), `firebase-admin` Firestore, `@nestjs/platform-express` (multer) for uploads, Jest + ts-jest, supertest for e2e. pnpm.

**Spec:** `docs/superpowers/specs/2026-07-26-market-data-trade-execution-modules-design.md`

---

## File Structure

**Phase 1 — `contracts/`**
- Create `backend/src/contracts/contracts.constants.ts` — `ContractSpec` interface + `CONTRACTS` map.
- Create `backend/src/contracts/contracts.service.ts` — `ContractsService`.
- Create `backend/src/contracts/contracts.module.ts` — `@Global()` module.
- Create `backend/src/contracts/contracts.service.spec.ts`.

**Phase 2 — `common/` + `market-data/`**
- Create `backend/src/common/session-time.ts` — tz/day/window helpers + `hhmmToMinutes`.
- Create `backend/src/common/session-time.spec.ts`.
- Create `backend/src/market-data/candle.ts` — `Candle`, `StoredCandle`, mappers, `Interval`, `intervalToSeconds`.
- Create `backend/src/market-data/csv-parser.ts` — `parseCsv`.
- Create `backend/src/market-data/csv-parser.spec.ts`.
- Create `backend/src/market-data/coverage.ts` — `analyzeCoverage`, `CoverageResult`.
- Create `backend/src/market-data/coverage.spec.ts`.
- Create `backend/src/market-data/market-data.service.ts` — `MarketDataService`.
- Create `backend/src/market-data/market-data.service.spec.ts`.
- Create `backend/src/market-data/market-data.controller.ts` — upload + read endpoints.
- Create `backend/src/market-data/market-data.module.ts`.
- Modify `backend/src/app.module.ts` — import `MarketDataModule` + `ContractsModule`, register controller.
- Modify `backend/package.json` — add `@types/multer` dev dep.
- Create `backend/test/market-data.e2e-spec.ts`.

**Phase 3 — `execution/`**
- Create `backend/src/execution/engine.ts` — `simulateOrder`, `simulate`, `slHitsFirst`, types.
- Create `backend/src/execution/engine.spec.ts` — ported from `test/engine.test.js`.
- Create `backend/src/execution/orders.ts` — `normalizeOrders`, `RawOrder`, `NormalizedOrder`.
- Create `backend/src/execution/orders.spec.ts` — ported from `test/orders.test.js`.
- Create `backend/src/execution/execution-engine.ts` — `ExecutionEngine` injectable wrapper.
- Create `backend/src/execution/backtest.service.ts` — `BacktestService`.
- Create `backend/src/execution/backtest.service.spec.ts`.
- Create `backend/src/execution/backtest.controller.ts` — `POST /backtest`.
- Create `backend/src/execution/execution.module.ts`.
- Modify `backend/src/app.module.ts` — import `ExecutionModule`, register controller.
- Create `backend/test/backtest.e2e-spec.ts`.

**Conventions to follow (verify before starting):** read `backend/src/demo/firestore-demo.controller.ts`, `backend/src/demo/firestore-demo.controller.spec.ts`, `backend/src/firebase/firebase.module.ts`, and `backend/src/anthropic/anthropic.module.ts` for the established DI/token/spec patterns. All shell commands below run from `backend/`.

---

## Phase 1 — Contracts Registry

### Task 1: ContractSpec + CONTRACTS map

**Files:**
- Create: `backend/src/contracts/contracts.constants.ts`

- [ ] **Step 1: Write the constants file**

```ts
export interface ContractSpec {
  symbol: string;
  name: string;
  pointValue: number; // dollars per 1.0 point per contract (old --multiplier)
  tickSize: number;
  currency: string;
  timezone: string;
  rth: { open: string; close: string }; // 'HH:MM' local to `timezone`
}

export const CONTRACTS: Record<string, ContractSpec> = {
  MES: { symbol: 'MES', name: 'Micro E-mini S&P 500', pointValue: 5, tickSize: 0.25, currency: 'USD', timezone: 'America/New_York', rth: { open: '09:30', close: '16:00' } },
  ES: { symbol: 'ES', name: 'E-mini S&P 500', pointValue: 50, tickSize: 0.25, currency: 'USD', timezone: 'America/New_York', rth: { open: '09:30', close: '16:00' } },
  NQ: { symbol: 'NQ', name: 'E-mini Nasdaq-100', pointValue: 20, tickSize: 0.25, currency: 'USD', timezone: 'America/New_York', rth: { open: '09:30', close: '16:00' } },
  MNQ: { symbol: 'MNQ', name: 'Micro E-mini Nasdaq-100', pointValue: 2, tickSize: 0.25, currency: 'USD', timezone: 'America/New_York', rth: { open: '09:30', close: '16:00' } },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/contracts/contracts.constants.ts
git commit -m "feat(contracts): add ContractSpec and CONTRACTS registry map"
```

### Task 2: ContractsService

**Files:**
- Create: `backend/src/contracts/contracts.service.ts`
- Test: `backend/src/contracts/contracts.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { NotFoundException } from '@nestjs/common';
import { ContractsService } from './contracts.service';

describe('ContractsService', () => {
  const service = new ContractsService();

  it('get() returns the spec for a known symbol', () => {
    expect(service.get('MES').pointValue).toBe(5);
    expect(service.get('ES').pointValue).toBe(50);
    expect(service.get('MES').rth).toEqual({ open: '09:30', close: '16:00' });
  });

  it('get() throws NotFoundException for an unknown symbol', () => {
    expect(() => service.get('XYZ')).toThrow(NotFoundException);
  });

  it('has() reflects membership', () => {
    expect(service.has('NQ')).toBe(true);
    expect(service.has('XYZ')).toBe(false);
  });

  it('list() returns every seeded contract', () => {
    const symbols = service.list().map((c) => c.symbol).sort();
    expect(symbols).toEqual(['ES', 'MES', 'MNQ', 'NQ']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contracts.service`
Expected: FAIL — cannot find module `./contracts.service`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { CONTRACTS, ContractSpec } from './contracts.constants';

@Injectable()
export class ContractsService {
  get(symbol: string): ContractSpec {
    const spec = CONTRACTS[symbol];
    if (!spec) throw new NotFoundException(`Unknown contract symbol: ${symbol}`);
    return spec;
  }

  has(symbol: string): boolean {
    return Object.prototype.hasOwnProperty.call(CONTRACTS, symbol);
  }

  list(): ContractSpec[] {
    return Object.values(CONTRACTS);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- contracts.service`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/contracts.service.ts src/contracts/contracts.service.spec.ts
git commit -m "feat(contracts): add ContractsService with get/has/list"
```

### Task 3: ContractsModule

**Files:**
- Create: `backend/src/contracts/contracts.module.ts`

- [ ] **Step 1: Write the module**

```ts
import { Global, Module } from '@nestjs/common';
import { ContractsService } from './contracts.service';

@Global()
@Module({
  providers: [ContractsService],
  exports: [ContractsService],
})
export class ContractsModule {}
```

- [ ] **Step 2: Register it in app.module.ts**

Modify `backend/src/app.module.ts`: add `import { ContractsModule } from './contracts/contracts.module';` and add `ContractsModule` to the `imports` array of `@Module`.

- [ ] **Step 3: Verify the app compiles**

Run: `pnpm build`
Expected: build succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/contracts/contracts.module.ts src/app.module.ts
git commit -m "feat(contracts): add global ContractsModule and register it"
```

---

## Phase 2 — Shared Time Utils + Market-Data Module

### Task 4: Shared session-time helpers

Behavior-exact TypeScript port of `src/session.js`, plus an `hhmmToMinutes` helper used to turn `ContractSpec.rth` into minute bounds.

**Files:**
- Create: `backend/src/common/session-time.ts`
- Test: `backend/src/common/session-time.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import {
  dateForTimestamp,
  minutesOfDayForTimestamp,
  filterDay,
  filterTimeWindow,
  latestDate,
  hhmmToMinutes,
} from './session-time';

// 2026-07-14 13:30:00 UTC == 09:30 America/New_York (EDT, UTC-4).
const T_0930_ET = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
const T_0935_ET = T_0930_ET + 300;

describe('session-time', () => {
  it('dateForTimestamp returns YYYY-MM-DD in the tz', () => {
    expect(dateForTimestamp(T_0930_ET, 'America/New_York')).toBe('2026-07-14');
  });

  it('minutesOfDayForTimestamp returns local minutes since midnight', () => {
    expect(minutesOfDayForTimestamp(T_0930_ET, 'America/New_York')).toBe(570);
  });

  it('filterDay keeps only candles on the given local day', () => {
    const candles = [{ time: T_0930_ET }, { time: T_0930_ET - 86400 }] as any;
    expect(filterDay(candles, '2026-07-14', 'America/New_York')).toHaveLength(1);
  });

  it('filterTimeWindow keeps [open, close) local minutes', () => {
    const candles = [{ time: T_0930_ET }, { time: T_0935_ET }] as any;
    // window [570, 575) keeps only the 09:30 candle
    expect(filterTimeWindow(candles, 'America/New_York', 570, 575)).toHaveLength(1);
  });

  it('latestDate returns the last candle local day', () => {
    expect(latestDate([{ time: T_0930_ET }] as any, 'America/New_York')).toBe('2026-07-14');
  });

  it('hhmmToMinutes parses HH:MM', () => {
    expect(hhmmToMinutes('09:30')).toBe(570);
    expect(hhmmToMinutes('16:00')).toBe(960);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- session-time`
Expected: FAIL — cannot find module `./session-time`.

- [ ] **Step 3: Write the implementation**

```ts
export interface HasTime {
  time: number; // Unix epoch seconds
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = dayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(tz, fmt);
  }
  return fmt;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function timeFormatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = timeFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormatters.set(tz, fmt);
  }
  return fmt;
}

// en-CA formats as YYYY-MM-DD.
export function dateForTimestamp(unixSeconds: number, tz: string): string {
  return dayFormatterFor(tz).format(new Date(unixSeconds * 1000));
}

// Minutes since local midnight in `tz` (0..1439).
export function minutesOfDayForTimestamp(unixSeconds: number, tz: string): number {
  const parts = timeFormatterFor(tz).formatToParts(new Date(unixSeconds * 1000));
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return hour * 60 + minute;
}

export function latestDate<T extends HasTime>(candles: T[], tz: string): string {
  return dateForTimestamp(candles[candles.length - 1].time, tz);
}

export function filterDay<T extends HasTime>(candles: T[], date: string, tz: string): T[] {
  return candles.filter((c) => dateForTimestamp(c.time, tz) === date);
}

// Keeps candles whose local time of day is in [openMinutes, closeMinutes).
export function filterTimeWindow<T extends HasTime>(candles: T[], tz: string, openMinutes: number, closeMinutes: number): T[] {
  return candles.filter((c) => {
    const m = minutesOfDayForTimestamp(c.time, tz);
    return m >= openMinutes && m < closeMinutes;
  });
}

// 'HH:MM' -> minutes since midnight.
export function hhmmToMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`Invalid HH:MM time: "${hhmm}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- session-time`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/session-time.ts src/common/session-time.spec.ts
git commit -m "feat(common): port tz/session-time helpers to TypeScript"
```

### Task 5: Candle types + interval helpers

**Files:**
- Create: `backend/src/market-data/candle.ts`

- [ ] **Step 1: Write the file**

```ts
// Canonical candle used by the engine and returned by MarketDataService.
export interface Candle {
  time: number; // Unix epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

// Compact on-disk projection stored inside a day-doc's `candles` array.
export interface StoredCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export function toStored(c: Candle): StoredCandle {
  return { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close };
}

export function fromStored(s: StoredCandle): Candle {
  return { time: s.t, open: s.o, high: s.h, low: s.l, close: s.c };
}

export type Interval = 'min-1' | 'min-5' | 'min-15' | 'min-60';

const INTERVAL_SECONDS: Record<Interval, number> = {
  'min-1': 60,
  'min-5': 300,
  'min-15': 900,
  'min-60': 3600,
};

export function isInterval(value: string): value is Interval {
  return Object.prototype.hasOwnProperty.call(INTERVAL_SECONDS, value);
}

export function intervalToSeconds(interval: Interval): number {
  return INTERVAL_SECONDS[interval];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/market-data/candle.ts
git commit -m "feat(market-data): add Candle/StoredCandle types and interval helpers"
```

### Task 6: CSV parser

Behavior-exact port of `src/parse-csv.js`, typed to `Candle`.

**Files:**
- Create: `backend/src/market-data/csv-parser.ts`
- Test: `backend/src/market-data/csv-parser.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { parseCsv } from './csv-parser';

describe('parseCsv', () => {
  it('parses OHLC and ignores indicator columns, sorted ascending', () => {
    const text = [
      'time,open,high,low,close,Extra Indicator',
      '1782878700,2,3,1,2,foo',
      '1782878400,1,2,0,1,bar',
    ].join('\n');
    const candles = parseCsv(text);
    expect(candles).toEqual([
      { time: 1782878400, open: 1, high: 2, low: 0, close: 1 },
      { time: 1782878700, open: 2, high: 3, low: 1, close: 2 },
    ]);
  });

  it('is case-insensitive on the header', () => {
    const text = 'Time,Open,High,Low,Close\n1782878400,1,2,0,1';
    expect(parseCsv(text)[0].time).toBe(1782878400);
  });

  it('throws when a required column is missing', () => {
    expect(() => parseCsv('time,open,high,low\n1,2,3,4')).toThrow('missing required column: close');
  });

  it('throws on a non-numeric cell', () => {
    const text = 'time,open,high,low,close\n1782878400,x,2,0,1';
    expect(() => parseCsv(text)).toThrow('invalid open value');
  });

  it('throws when there are no data rows', () => {
    expect(() => parseCsv('time,open,high,low,close')).toThrow('no data rows');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- csv-parser`
Expected: FAIL — cannot find module `./csv-parser`.

- [ ] **Step 3: Write the implementation**

```ts
import { Candle } from './candle';

const REQUIRED = ['time', 'open', 'high', 'low', 'close'] as const;

// Parses TradingView-style CSV text into Candle objects, ignoring any
// indicator columns beyond the required OHLC set.
export function parseCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/);
  const rows: { lineNumber: number; cols: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') rows.push({ lineNumber: i + 1, cols: lines[i].split(',') });
  }
  if (rows.length < 2) throw new Error('CSV has no data rows');

  const header = rows[0].cols.map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const name of REQUIRED) {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV missing required column: ${name}`);
    idx[name] = i;
  }

  const candles = rows.slice(1).map(({ lineNumber, cols }) => {
    const candle: Record<string, number> = {};
    for (const name of REQUIRED) {
      const rawValue = cols[idx[name]];
      const value = Number(rawValue);
      if (rawValue === undefined || rawValue.trim() === '' || !Number.isFinite(value)) {
        throw new Error(`CSV line ${lineNumber}: invalid ${name} value "${rawValue ?? ''}"`);
      }
      candle[name] = value;
    }
    return candle as unknown as Candle;
  });
  candles.sort((a, b) => a.time - b.time);
  return candles;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- csv-parser`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/market-data/csv-parser.ts src/market-data/csv-parser.spec.ts
git commit -m "feat(market-data): port CSV parser to TypeScript"
```

### Task 7: Coverage / gap analysis

**Files:**
- Create: `backend/src/market-data/coverage.ts`
- Test: `backend/src/market-data/coverage.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { analyzeCoverage } from './coverage';
import { Candle } from './candle';

// Build a full RTH 5-min day (78 bars, 09:30..15:55 ET) for 2026-07-14.
const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000); // 09:30 ET
const STEP = 300;
const WINDOW = { openMin: 570, closeMin: 960, intervalSec: 300, tz: 'America/New_York' };

function bar(time: number): Candle {
  return { time, open: 1, high: 2, low: 0, close: 1 };
}
function fullDay(): Candle[] {
  return Array.from({ length: 78 }, (_, i) => bar(OPEN + i * STEP));
}

describe('analyzeCoverage', () => {
  it('a full RTH day is complete', () => {
    const r = analyzeCoverage(fullDay(), WINDOW);
    expect(r.complete).toBe(true);
    expect(r.expectedCount).toBe(78);
    expect(r.presentCount).toBe(78);
    expect(r.hasOpen).toBe(true);
    expect(r.hasClose).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it('a missing interior bar is an incomplete day with a gap', () => {
    const candles = fullDay().filter((_, i) => i !== 40); // drop one mid-session bar
    const r = analyzeCoverage(candles, WINDOW);
    expect(r.complete).toBe(false);
    expect(r.presentCount).toBe(77);
    expect(r.gaps).toEqual([{ afterTime: OPEN + 39 * STEP, missing: 1 }]);
  });

  it('a late start (no open bar) is incomplete', () => {
    const r = analyzeCoverage(fullDay().slice(1), WINDOW);
    expect(r.complete).toBe(false);
    expect(r.hasOpen).toBe(false);
  });

  it('an early end (no close bar) is incomplete', () => {
    const r = analyzeCoverage(fullDay().slice(0, -1), WINDOW);
    expect(r.complete).toBe(false);
    expect(r.hasClose).toBe(false);
  });

  it('ignores candles outside the RTH window', () => {
    const withPremarket = [bar(OPEN - STEP), ...fullDay()];
    const r = analyzeCoverage(withPremarket, WINDOW);
    expect(r.complete).toBe(true);
    expect(r.presentCount).toBe(78);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- coverage`
Expected: FAIL — cannot find module `./coverage`.

- [ ] **Step 3: Write the implementation**

```ts
import { Candle } from './candle';
import { minutesOfDayForTimestamp } from '../common/session-time';

export interface CoverageWindow {
  openMin: number;    // RTH open, minutes since local midnight (e.g. 570)
  closeMin: number;   // RTH close, minutes since local midnight (e.g. 960)
  intervalSec: number;
  tz: string;
}

export interface CoverageGap {
  afterTime: number; // epoch seconds of the candle the gap follows
  missing: number;   // number of absent bars in the gap
}

export interface CoverageResult {
  complete: boolean;
  expectedCount: number;
  presentCount: number;
  hasOpen: boolean;
  hasClose: boolean;
  gaps: CoverageGap[];
}

// Judges whether `candles` fully cover the [openMin, closeMin) RTH grid at
// `intervalSec` spacing. DST-safe: local minutes are read off real timestamps,
// and DST transitions never fall inside RTH.
export function analyzeCoverage(candles: Candle[], window: CoverageWindow): CoverageResult {
  const { openMin, closeMin, intervalSec, tz } = window;
  const intervalMin = intervalSec / 60;
  const expectedCount = (closeMin - openMin) / intervalMin;

  const inWindow = candles
    .filter((c) => {
      const m = minutesOfDayForTimestamp(c.time, tz);
      return m >= openMin && m < closeMin;
    })
    .sort((a, b) => a.time - b.time);

  const presentCount = inWindow.length;
  const hasOpen = presentCount > 0 && minutesOfDayForTimestamp(inWindow[0].time, tz) === openMin;
  const hasClose =
    presentCount > 0 && minutesOfDayForTimestamp(inWindow[presentCount - 1].time, tz) === closeMin - intervalMin;

  const gaps: CoverageGap[] = [];
  for (let i = 1; i < inWindow.length; i++) {
    const delta = inWindow[i].time - inWindow[i - 1].time;
    if (delta !== intervalSec) {
      gaps.push({ afterTime: inWindow[i - 1].time, missing: delta / intervalSec - 1 });
    }
  }

  const complete = hasOpen && hasClose && gaps.length === 0 && presentCount === expectedCount;
  return { complete, expectedCount, presentCount, hasOpen, hasClose, gaps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- coverage`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/market-data/coverage.ts src/market-data/coverage.spec.ts
git commit -m "feat(market-data): add RTH coverage/gap analysis"
```

### Task 8: MarketDataService — read APIs

Establish the Firestore path helpers and the read side first; ingest lands in Task 9.

**Files:**
- Create: `backend/src/market-data/market-data.service.ts`
- Test: `backend/src/market-data/market-data.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { Test } from '@nestjs/testing';
import { MarketDataService } from './market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { FIRESTORE } from '../firebase/firebase.constants';

function makeFirestore(dayDoc: any) {
  const doc = jest.fn(() => ({
    get: jest.fn(() => Promise.resolve({ exists: !!dayDoc, data: () => dayDoc })),
    collection: jest.fn(() => collection),
  }));
  const listDocuments = jest.fn(() => Promise.resolve([{ id: '2026-07-14' }, { id: '2026-07-15' }]));
  const collection: any = jest.fn(() => ({ doc, listDocuments }));
  return { collection } as any;
}

async function build(firestore: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      MarketDataService,
      ContractsService,
      { provide: FIRESTORE, useValue: firestore },
    ],
  }).compile();
  return moduleRef.get(MarketDataService);
}

describe('MarketDataService reads', () => {
  it('getDay returns mapped candles for an existing day', async () => {
    const firestore = makeFirestore({ candles: [{ t: 100, o: 1, h: 2, l: 0, c: 1 }] });
    const service = await build(firestore);
    const candles = await service.getDay('MES', 'min-5', '2026-07-14');
    expect(candles).toEqual([{ time: 100, open: 1, high: 2, low: 0, close: 1 }]);
  });

  it('getDay returns null for a missing day', async () => {
    const service = await build(makeFirestore(null));
    expect(await service.getDay('MES', 'min-5', '2026-07-14')).toBeNull();
  });

  it('rejects an unknown symbol', async () => {
    const service = await build(makeFirestore(null));
    await expect(service.getDay('XYZ', 'min-5', '2026-07-14')).rejects.toThrow('Unknown contract');
  });

  it('rejects an invalid interval', async () => {
    const service = await build(makeFirestore(null));
    await expect(service.getDay('MES', 'min-3' as any, '2026-07-14')).rejects.toThrow('interval');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- market-data.service`
Expected: FAIL — cannot find module `./market-data.service`.

- [ ] **Step 3: Write the read-side implementation**

```ts
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { ContractsService } from '../contracts/contracts.service';
import { Candle, Interval, StoredCandle, fromStored, isInterval } from './candle';

export interface StoredDay {
  date: string;
  count: number;
  complete: boolean;
}

@Injectable()
export class MarketDataService {
  constructor(
    @Inject(FIRESTORE) private readonly firestore: Firestore,
    private readonly contracts: ContractsService,
  ) {}

  private dayCollection(symbol: string, interval: Interval) {
    // markets/{symbol}/{interval}
    return this.firestore.collection('markets').doc(symbol).collection(interval);
  }

  private validate(symbol: string, interval: string): asserts interval is Interval {
    this.contracts.get(symbol); // throws NotFoundException on unknown symbol
    if (!isInterval(interval)) throw new BadRequestException(`Unsupported interval: ${interval}`);
  }

  async getDay(symbol: string, interval: Interval, date: string): Promise<Candle[] | null> {
    this.validate(symbol, interval);
    const snap = await this.dayCollection(symbol, interval).doc(date).get();
    if (!snap.exists) return null;
    const stored = (snap.data()?.candles ?? []) as StoredCandle[];
    return stored.map(fromStored);
  }

  async listStoredDays(symbol: string, interval: Interval): Promise<StoredDay[]> {
    this.validate(symbol, interval);
    const snap = await this.dayCollection(symbol, interval).get();
    return snap.docs
      .map((d) => {
        const data = d.data() as any;
        return { date: d.id, count: data.count ?? 0, complete: data.coverage?.rthComplete ?? false };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
```

> Note: `listStoredDays` uses a full `get()` (small day-doc metadata) for simplicity and to read the stored `complete` flag. If read cost ever matters, switch to `.select('count', 'coverage')` to avoid pulling `candles` arrays.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- market-data.service`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/market-data/market-data.service.ts src/market-data/market-data.service.spec.ts
git commit -m "feat(market-data): add MarketDataService read APIs (getDay, listStoredDays)"
```

### Task 9: MarketDataService — idempotent CSV ingest

**Files:**
- Modify: `backend/src/market-data/market-data.service.ts`
- Modify: `backend/src/market-data/market-data.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add a `runTransaction` fake and tests. Append to the spec:

```ts
// Fake Firestore supporting doc().get inside runTransaction and set capture.
function makeIngestFirestore(existingCandles: any[] | null) {
  const store: any = { candles: existingCandles };
  const docRef = { id: 'ref' };
  const set = jest.fn((_ref: any, data: any) => { store.written = data; });
  const tx = {
    get: jest.fn(() => Promise.resolve({ exists: existingCandles !== null, data: () => ({ candles: existingCandles }) })),
    set,
  };
  const doc = jest.fn(() => docRef);
  const collection = jest.fn(() => ({ doc }));
  const firestore = {
    collection: jest.fn(() => ({ doc: jest.fn(() => ({ collection })) })),
    runTransaction: jest.fn((fn: any) => fn(tx)),
  };
  return { firestore, tx, store };
}

describe('MarketDataService.ingestCsv', () => {
  // 09:30 ET 2026-07-14, then 09:35 — same day.
  const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
  const csv = (rows: number[][]) =>
    ['time,open,high,low,close', ...rows.map((r) => r.join(','))].join('\n');

  async function buildWith(firestore: any) {
    const moduleRef = await Test.createTestingModule({
      providers: [MarketDataService, ContractsService, { provide: FIRESTORE, useValue: firestore }],
    }).compile();
    return moduleRef.get(MarketDataService);
  }

  it('creates a new day and reports rows added', async () => {
    const { firestore, store } = makeIngestFirestore(null);
    const service = await buildWith(firestore);
    const summary = await service.ingestCsv('MES', 'min-5', csv([[OPEN, 1, 2, 0, 1], [OPEN + 300, 2, 3, 1, 2]]), {});
    expect(summary.totalRows).toBe(2);
    expect(summary.days[0]).toMatchObject({ date: '2026-07-14', added: 2, updated: 0, unchanged: false, totalAfter: 2 });
    expect(store.written.candles).toEqual([{ t: OPEN, o: 1, h: 2, l: 0, c: 1 }, { t: OPEN + 300, o: 2, h: 3, l: 1, c: 2 }]);
  });

  it('merges by timestamp: existing untouched, new appended, dup overwritten', async () => {
    const existing = [{ t: OPEN, o: 1, h: 1, l: 1, c: 1 }];
    const { firestore, store } = makeIngestFirestore(existing);
    const service = await buildWith(firestore);
    const summary = await service.ingestCsv('MES', 'min-5', csv([[OPEN, 9, 9, 9, 9], [OPEN + 300, 2, 3, 1, 2]]), {});
    expect(summary.days[0]).toMatchObject({ added: 1, updated: 1, unchanged: false, totalAfter: 2 });
    expect(store.written.candles).toEqual([{ t: OPEN, o: 9, h: 9, l: 9, c: 9 }, { t: OPEN + 300, o: 2, h: 3, l: 1, c: 2 }]);
  });

  it('skips the write when the merge changes nothing', async () => {
    const existing = [{ t: OPEN, o: 1, h: 2, l: 0, c: 1 }];
    const { firestore, tx } = makeIngestFirestore(existing);
    const service = await buildWith(firestore);
    const summary = await service.ingestCsv('MES', 'min-5', csv([[OPEN, 1, 2, 0, 1]]), {});
    expect(summary.days[0]).toMatchObject({ added: 0, updated: 0, unchanged: true });
    expect(tx.set).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- market-data.service`
Expected: FAIL — `ingestCsv` is not a function.

- [ ] **Step 3: Add ingest to the service**

Add imports at the top of `market-data.service.ts`:

```ts
import { FieldValue } from 'firebase-admin/firestore';
import { parseCsv } from './csv-parser';
import { toStored, intervalToSeconds } from './candle';
import { analyzeCoverage } from './coverage';
import { dateForTimestamp, hhmmToMinutes } from '../common/session-time';
```

Add these types and methods to the class body:

```ts
export interface DayIngestResult {
  date: string;
  added: number;
  updated: number;
  unchanged: boolean;
  totalAfter: number;
  complete: boolean;
}
export interface IngestSummary {
  symbol: string;
  interval: string;
  totalRows: number;
  days: DayIngestResult[];
}
export interface IngestOptions {
  replace?: boolean;
}
```

Methods inside `MarketDataService`:

```ts
  async ingestCsv(symbol: string, interval: Interval, csvText: string, opts: IngestOptions): Promise<IngestSummary> {
    this.validate(symbol, interval);
    const spec = this.contracts.get(symbol);
    const candles = parseCsv(csvText);

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
      intervalSec: intervalToSeconds(interval),
      tz: spec.timezone,
    };

    const days: DayIngestResult[] = [];
    for (const [date, dayCandles] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      days.push(await this.upsertDay(symbol, interval, date, dayCandles.map(toStored), window, opts.replace === true));
    }
    return { symbol, interval, totalRows: candles.length, days };
  }

  private async upsertDay(
    symbol: string,
    interval: Interval,
    date: string,
    incoming: StoredCandle[],
    window: { openMin: number; closeMin: number; intervalSec: number; tz: string },
    replace: boolean,
  ): Promise<DayIngestResult> {
    const ref = this.dayCollection(symbol, interval).doc(date);
    return this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing: StoredCandle[] = snap.exists ? ((snap.data()?.candles ?? []) as StoredCandle[]) : [];

      const existingByT = new Map(existing.map((c) => [c.t, c]));
      let added = 0;
      let updated = 0;
      let merged: StoredCandle[];
      if (replace) {
        merged = [...incoming].sort((a, b) => a.t - b.t);
      } else {
        const map = new Map(existingByT);
        for (const c of incoming) {
          const prev = map.get(c.t);
          if (prev === undefined) added += 1;
          else if (prev.o !== c.o || prev.h !== c.h || prev.l !== c.l || prev.c !== c.c) updated += 1;
          map.set(c.t, c);
        }
        merged = [...map.values()].sort((a, b) => a.t - b.t);
      }

      const unchanged =
        merged.length === existing.length &&
        merged.every((c, i) => {
          const e = existing[i];
          return e && e.t === c.t && e.o === c.o && e.h === c.h && e.l === c.l && e.c === c.c;
        });

      if (unchanged) {
        return { date, added: 0, updated: 0, unchanged: true, totalAfter: merged.length, complete: snap.data()?.coverage?.rthComplete ?? false };
      }

      const coverage = analyzeCoverage(merged.map((s) => ({ time: s.t, open: s.o, high: s.h, low: s.l, close: s.c })), window);
      tx.set(ref, {
        symbol,
        interval,
        date,
        candles: merged,
        count: merged.length,
        firstTime: merged[0]?.t ?? null,
        lastTime: merged[merged.length - 1]?.t ?? null,
        coverage: {
          rthComplete: coverage.complete,
          rthExpectedCount: coverage.expectedCount,
          rthPresentCount: coverage.presentCount,
          hasOpen: coverage.hasOpen,
          hasClose: coverage.hasClose,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { date, added: replace ? merged.length : added, updated, unchanged: false, totalAfter: merged.length, complete: coverage.complete };
    });
  }
```

> Move the `DayIngestResult`/`IngestSummary`/`IngestOptions` interfaces to the top of the file (module scope), not inside the class.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- market-data.service`
Expected: PASS (all read + ingest tests).

- [ ] **Step 5: Commit**

```bash
git add src/market-data/market-data.service.ts src/market-data/market-data.service.spec.ts
git commit -m "feat(market-data): idempotent per-day merge-upsert CSV ingest with coverage"
```

### Task 10: MarketDataController + module + wiring

**Files:**
- Create: `backend/src/market-data/market-data.controller.ts`
- Create: `backend/src/market-data/market-data.module.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/package.json` (add `@types/multer`)

- [ ] **Step 1: Add the multer types dev dependency**

Run: `pnpm add -D @types/multer`
Expected: `@types/multer` added to `devDependencies`.

- [ ] **Step 2: Write the controller**

```ts
import { BadRequestException, Controller, Get, Inject, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MarketDataService } from './market-data.service';
import { Interval, isInterval } from './candle';

@Controller('markets/:symbol/:interval')
export class MarketDataController {
  constructor(@Inject(MarketDataService) private readonly marketData: MarketDataService) {}

  private asInterval(interval: string): Interval {
    if (!isInterval(interval)) throw new BadRequestException(`Unsupported interval: ${interval}`);
    return interval;
  }

  @Post('candles')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('symbol') symbol: string,
    @Param('interval') interval: string,
    @Query('replace') replace: string | undefined,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Missing multipart file field "file"');
    const csvText = file.buffer.toString('utf8');
    return this.marketData.ingestCsv(symbol, this.asInterval(interval), csvText, { replace: replace === 'true' });
  }

  @Get('days')
  async days(@Param('symbol') symbol: string, @Param('interval') interval: string) {
    return this.marketData.listStoredDays(symbol, this.asInterval(interval));
  }

  @Get('candles')
  async candles(@Param('symbol') symbol: string, @Param('interval') interval: string, @Query('date') date: string) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Query param "date" (YYYY-MM-DD) is required');
    const candles = await this.marketData.getDay(symbol, this.asInterval(interval), date);
    return { symbol, interval, date, candles: candles ?? [] };
  }
}
```

- [ ] **Step 3: Write the module**

```ts
import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';

@Module({
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
```

- [ ] **Step 4: Wire into app.module.ts**

Modify `backend/src/app.module.ts`: add `import { MarketDataModule } from './market-data/market-data.module';` and `import { MarketDataController } from './market-data/market-data.controller';`. Add `MarketDataModule` to `imports` and `MarketDataController` to `controllers`.

- [ ] **Step 5: Verify build + full test run**

Run: `pnpm build && pnpm test`
Expected: build succeeds; all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/market-data/market-data.controller.ts src/market-data/market-data.module.ts src/app.module.ts package.json pnpm-lock.yaml
git commit -m "feat(market-data): add upload/read controller and wire MarketDataModule"
```

### Task 11: Market-data e2e (multipart upload)

**Files:**
- Create: `backend/test/market-data.e2e-spec.ts`

- [ ] **Step 1: Write the e2e test with a mocked Firestore**

Read `backend/test/app.e2e-spec.ts` first for the bootstrap pattern. Override `FIRESTORE` with an in-memory fake so no live GCP is touched.

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FIRESTORE } from '../src/firebase/firebase.constants';

// Minimal in-memory Firestore fake: one map of day-doc data keyed by doc path.
function fakeFirestore() {
  const docs = new Map<string, any>();
  const makeDoc = (path: string) => ({
    id: path.split('/').pop(),
    get: () => Promise.resolve({ exists: docs.has(path), data: () => docs.get(path) }),
  });
  const makeCollection = (base: string) => ({
    doc: (id: string) => {
      const path = `${base}/${id}`;
      return { ...makeDoc(path), collection: (sub: string) => makeCollection(`${path}/${sub}`) };
    },
    get: () => Promise.resolve({ docs: [...docs.keys()].filter((k) => k.startsWith(base + '/')).map((k) => ({ id: k.split('/').pop(), data: () => docs.get(k) })) }),
    listDocuments: () => Promise.resolve([...docs.keys()].filter((k) => k.startsWith(base + '/')).map((k) => ({ id: k.split('/').pop() }))),
  });
  return {
    collection: (name: string) => makeCollection(name),
    runTransaction: async (fn: any) => fn({
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any) => { docs.set(`markets/${data.symbol}/${data.interval}/${data.date}`, data); },
    }),
  };
}

describe('Market data (e2e)', () => {
  let app: INestApplication;
  const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE).useValue(fakeFirestore())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it('uploads a CSV and lists the ingested day', async () => {
    const csv = ['time,open,high,low,close', `${OPEN},1,2,0,1`, `${OPEN + 300},2,3,1,2`].join('\n');
    const res = await request(app.getHttpServer())
      .post('/markets/MES/min-5/candles')
      .attach('file', Buffer.from(csv), 'mes.csv')
      .expect(201);
    expect(res.body.totalRows).toBe(2);
    expect(res.body.days[0].date).toBe('2026-07-14');

    const days = await request(app.getHttpServer()).get('/markets/MES/min-5/days').expect(200);
    expect(days.body.map((d: any) => d.date)).toContain('2026-07-14');
  });

  it('rejects an unknown symbol with 404', async () => {
    await request(app.getHttpServer())
      .post('/markets/XYZ/min-5/candles')
      .attach('file', Buffer.from('time,open,high,low,close\n1,1,1,1,1'), 'x.csv')
      .expect(404);
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `pnpm test:e2e -- market-data`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add test/market-data.e2e-spec.ts
git commit -m "test(market-data): e2e multipart upload and day listing"
```

---

## Phase 3 — Trade-Execution Module

### Task 12: Order types + normalizeOrders

Behavior-exact port of `src/orders.js`.

**Files:**
- Create: `backend/src/execution/orders.ts`
- Test: `backend/src/execution/orders.spec.ts`

- [ ] **Step 1: Port the existing test**

Open `test/orders.test.js` (63 lines) and translate it to Jest in `orders.spec.ts` using this mechanical recipe:
- Replace `import { test } from 'node:test'; import assert from 'node:assert/strict';` with nothing (Jest globals).
- `test('name', () => {...})` → `it('name', () => {...})`, all wrapped in one `describe('normalizeOrders', () => { ... })`.
- `assert.deepEqual(a, b)` → `expect(a).toEqual(b)`.
- `assert.throws(() => fn(), /regex/)` → `expect(() => fn()).toThrow(regex)`.
- `assert.equal(a, b)` → `expect(a).toBe(b)`.
- Update the import to `import { normalizeOrders } from './orders';`.

Add at least these cases if not already present:

```ts
import { normalizeOrders } from './orders';

describe('normalizeOrders', () => {
  it('fills defaults and auto-assigns ids', () => {
    expect(normalizeOrders([{ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 }])).toEqual([
      { id: 'long-1', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 },
    ]);
  });
  it('rejects a bad side', () => {
    expect(() => normalizeOrders([{ side: 'up', entry: 1, stopLoss: 0, takeProfit: 2 } as any])).toThrow('side must be');
  });
  it('enforces long ordering stopLoss < entry < takeProfit', () => {
    expect(() => normalizeOrders([{ side: 'long', entry: 100, stopLoss: 110, takeProfit: 120 }])).toThrow('long requires');
  });
  it('rejects duplicate ids', () => {
    expect(() => normalizeOrders([
      { id: 'x', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 },
      { id: 'x', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 },
    ])).toThrow('Duplicate order id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- execution/orders`
Expected: FAIL — cannot find module `./orders`.

- [ ] **Step 3: Write the implementation**

```ts
export type Side = 'long' | 'short';

export interface RawOrder {
  id?: string | number;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty?: number;
}

export interface NormalizedOrder {
  id: string;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
}

// Validates raw orders and fills in defaults (id, qty).
export function normalizeOrders(raw: unknown): NormalizedOrder[] {
  if (!Array.isArray(raw)) throw new Error('Orders file must be a JSON array');
  const counters: Record<Side, number> = { long: 0, short: 0 };
  const seen = new Set<string>();

  return raw.map((order: any, i: number) => {
    const where = `Order ${i + 1}`;
    if (order === null || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error(`${where}: must be an object`);
    }
    const side = order.side;
    if (side !== 'long' && side !== 'short') {
      throw new Error(`${where}: side must be "long" or "short"`);
    }
    for (const field of ['entry', 'stopLoss', 'takeProfit']) {
      if (typeof order[field] !== 'number' || !Number.isFinite(order[field])) {
        throw new Error(`${where}: ${field} must be a number`);
      }
    }
    const { entry, stopLoss, takeProfit } = order;
    if (side === 'long' && !(stopLoss < entry && entry < takeProfit)) {
      throw new Error(`${where}: long requires stopLoss < entry < takeProfit`);
    }
    if (side === 'short' && !(takeProfit < entry && entry < stopLoss)) {
      throw new Error(`${where}: short requires takeProfit < entry < stopLoss`);
    }
    let qty = 1;
    if (order.qty !== undefined) {
      if (!Number.isInteger(order.qty) || order.qty < 1) {
        throw new Error(`${where}: qty must be a positive integer`);
      }
      qty = order.qty;
    }
    counters[side as Side] += 1;
    const id = order.id === undefined ? `${side}-${counters[side as Side]}` : String(order.id);
    if (seen.has(id)) throw new Error(`Duplicate order id: "${id}"`);
    seen.add(id);
    return { id, side, entry, stopLoss, takeProfit, qty };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- execution/orders`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/orders.ts src/execution/orders.spec.ts
git commit -m "feat(execution): port order normalization to TypeScript"
```

### Task 13: Pure engine (simulateOrder / simulate)

Behavior-exact port of `src/engine.js`. **This is the primary evaluation core — port the whole test suite.**

**Files:**
- Create: `backend/src/execution/engine.ts`
- Test: `backend/src/execution/engine.spec.ts`

- [ ] **Step 1: Port the full engine test suite**

Translate `test/engine.test.js` (293 lines) into `engine.spec.ts` using the SAME node:test→Jest recipe from Task 12 (`test(...)`→`it(...)` inside a `describe('engine', ...)`; `assert.deepEqual`→`toEqual`; `assert.equal`→`toBe`; `assert.throws(fn, /re/)`→`expect(fn).toThrow(/re/)`; drop the node:test/assert imports). Change imports to `import { simulateOrder, simulate } from './engine';`. Port every case verbatim — do not drop any. The suite must continue to cover: touch-fill from the correct side, armed gating (price past entry on the wrong side does not fill until it returns), the entry time window (openMinutes/cutoffMinutes with tz), SL-only / TP-only exits, the ambiguous-candle `slHitsFirst` heuristic (bullish→long SL first, bearish→short SL first, flat treated bullish), EOD close, NOT_FILLED, closestApproach, maxAdverseExcursion / maxFavorableExcursion, rMultiple (qty-independent, null when riskDistance is 0), and PnL points/dollars + summary aggregation in `simulate`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- execution/engine`
Expected: FAIL — cannot find module `./engine`.

- [ ] **Step 3: Write the implementation**

```ts
import { minutesOfDayForTimestamp } from '../common/session-time';
import { Candle } from '../market-data/candle';
import { NormalizedOrder, Side } from './orders';

export type OrderStatus = 'SL' | 'TP' | 'EOD' | 'NOT_FILLED';

export interface SimulateOptions {
  openMinutes?: number | null;
  cutoffMinutes?: number | null;
  tz?: string;
}

export interface OrderOutcome {
  status: OrderStatus;
  fillTime: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  maxAdverseExcursion: number | null;
  maxFavorableExcursion: number | null;
  rMultiple: number | null;
  closestApproach: number | null;
}

export interface SimResult extends NormalizedOrder, OrderOutcome {
  points: number | null;
  dollars: number | null;
}

export interface SimSummary {
  orders: number;
  filled: number;
  wins: number;
  losses: number;
  netPoints: number;
  netDollars: number;
}

function slHitsFirst(candle: Candle, side: Side): boolean {
  const bullish = candle.close >= candle.open;
  return side === 'long' ? bullish : !bullish;
}

export function simulateOrder(order: NormalizedOrder, candles: Candle[], options: SimulateOptions = {}): OrderOutcome {
  const { side, entry, stopLoss, takeProfit } = order;
  const { openMinutes = null, cutoffMinutes = null, tz = 'UTC' } = options;
  const direction = side === 'long' ? 1 : -1;
  const riskDistance = Math.abs(entry - stopLoss);
  let fillTime: number | null = null;
  let armed = false;
  let closestApproach: number | null = null;
  let maxAdverseExcursion = 0;
  let maxFavorableExcursion = 0;

  const finish = (status: OrderStatus, exitTime: number, exitPrice: number): OrderOutcome => ({
    status,
    fillTime,
    exitTime,
    exitPrice,
    maxAdverseExcursion,
    maxFavorableExcursion,
    rMultiple: riskDistance === 0 ? null : ((exitPrice - entry) * direction) / riskDistance,
    closestApproach: null,
  });

  for (const candle of candles) {
    if (fillTime === null) {
      const localMinutes =
        openMinutes === null && cutoffMinutes === null ? null : minutesOfDayForTimestamp(candle.time, tz);
      const afterOpen = openMinutes === null || (localMinutes as number) >= openMinutes;
      const beforeCutoff = cutoffMinutes === null || (localMinutes as number) < cutoffMinutes;
      if (!afterOpen || !beforeCutoff) continue;

      const touchSidePrice = side === 'long' ? candle.low : candle.high;
      const distance = Math.abs(touchSidePrice - entry);
      if (closestApproach === null || distance < closestApproach) closestApproach = distance;

      if (side === 'long') {
        const touch = candle.low <= entry;
        if (touch && (armed || candle.open >= entry)) {
          fillTime = candle.time;
        } else {
          if (candle.high >= entry) armed = true;
          continue;
        }
      } else {
        const touch = candle.high >= entry;
        if (touch && (armed || candle.open <= entry)) {
          fillTime = candle.time;
        } else {
          if (candle.low <= entry) armed = true;
          continue;
        }
      }
    }

    const adverse = side === 'long' ? entry - candle.low : candle.high - entry;
    const favorable = side === 'long' ? candle.high - entry : entry - candle.low;
    if (adverse > maxAdverseExcursion) maxAdverseExcursion = adverse;
    if (favorable > maxFavorableExcursion) maxFavorableExcursion = favorable;

    const slHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss;
    const tpHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (slHit && tpHit) {
      return slHitsFirst(candle, side) ? finish('SL', candle.time, stopLoss) : finish('TP', candle.time, takeProfit);
    }
    if (slHit) return finish('SL', candle.time, stopLoss);
    if (tpHit) return finish('TP', candle.time, takeProfit);
  }

  if (fillTime === null) {
    return {
      status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
      maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null, closestApproach,
    };
  }
  const last = candles[candles.length - 1];
  return finish('EOD', last.time, last.close);
}

export function simulate(candles: Candle[], orders: NormalizedOrder[], multiplier: number, options: SimulateOptions = {}): { results: SimResult[]; summary: SimSummary } {
  const results: SimResult[] = orders.map((order) => {
    const outcome = simulateOrder(order, candles, options);
    let points: number | null = null;
    let dollars: number | null = null;
    if (outcome.status !== 'NOT_FILLED') {
      const direction = order.side === 'long' ? 1 : -1;
      points = ((outcome.exitPrice as number) - order.entry) * direction * order.qty;
      dollars = points * multiplier;
    }
    return { ...order, ...outcome, points, dollars };
  });

  const filled = results.filter((r) => r.status !== 'NOT_FILLED');
  const summary: SimSummary = {
    orders: results.length,
    filled: filled.length,
    wins: filled.filter((r) => (r.points as number) > 0).length,
    losses: filled.filter((r) => (r.points as number) < 0).length,
    netPoints: filled.reduce((sum, r) => sum + (r.points as number), 0),
    netDollars: filled.reduce((sum, r) => sum + (r.dollars as number), 0),
  };
  return { results, summary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- execution/engine`
Expected: PASS — every ported case green.

- [ ] **Step 5: Commit**

```bash
git add src/execution/engine.ts src/execution/engine.spec.ts
git commit -m "feat(execution): port pure trade-execution engine to TypeScript"
```

### Task 14: ExecutionEngine injectable wrapper

**Files:**
- Create: `backend/src/execution/execution-engine.ts`
- Test: `backend/src/execution/execution-engine.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { ExecutionEngine } from './execution-engine';

describe('ExecutionEngine', () => {
  it('delegates simulate() to the pure engine', () => {
    const engine = new ExecutionEngine();
    const candles = [{ time: 1, open: 100, high: 100, low: 95, close: 96 }];
    const orders = [{ id: 'long-1', side: 'long' as const, entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 }];
    const { summary } = engine.simulate(candles, orders, 5);
    expect(summary.orders).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- execution-engine`
Expected: FAIL — cannot find module `./execution-engine`.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable } from '@nestjs/common';
import { Candle } from '../market-data/candle';
import { NormalizedOrder } from './orders';
import { simulate, simulateOrder, SimulateOptions } from './engine';

@Injectable()
export class ExecutionEngine {
  simulate(candles: Candle[], orders: NormalizedOrder[], multiplier: number, options: SimulateOptions = {}) {
    return simulate(candles, orders, multiplier, options);
  }
  simulateOrder(order: NormalizedOrder, candles: Candle[], options: SimulateOptions = {}) {
    return simulateOrder(order, candles, options);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- execution-engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/execution-engine.ts src/execution/execution-engine.spec.ts
git commit -m "feat(execution): add injectable ExecutionEngine wrapper"
```

### Task 15: BacktestService (orchestration + coverage gate)

**Files:**
- Create: `backend/src/execution/backtest.service.ts`
- Test: `backend/src/execution/backtest.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BacktestService } from './backtest.service';
import { ExecutionEngine } from './execution-engine';
import { ContractsService } from '../contracts/contracts.service';
import { MarketDataService } from '../market-data/market-data.service';

// A full RTH 5-min day for 2026-07-14 (78 bars, flat candles).
const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
const fullDay = Array.from({ length: 78 }, (_, i) => ({ time: OPEN + i * 300, open: 100, high: 101, low: 99, close: 100 }));

async function build(getDay: any) {
  const marketData = { getDay: jest.fn(getDay) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      BacktestService,
      ExecutionEngine,
      ContractsService,
      { provide: MarketDataService, useValue: marketData },
    ],
  }).compile();
  return { service: moduleRef.get(BacktestService), marketData };
}

const req = {
  symbol: 'MES', interval: 'min-5' as const, date: '2026-07-14', session: 'rth' as const,
  orders: [{ side: 'long' as const, entry: 100, stopLoss: 95, takeProfit: 110 }],
};

describe('BacktestService', () => {
  it('runs the engine on a complete day and uses the contract pointValue', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    const result = await service.run(req);
    expect(result.summary.orders).toBe(1);
    expect(result.coverage.complete).toBe(true);
  });

  it('returns 404 when the day has no stored candles', async () => {
    const { service } = await build(() => Promise.resolve(null));
    await expect(service.run(req)).rejects.toThrow(/no.*data|not found/i);
  });

  it('refuses (422) an incomplete session unless allowIncomplete', async () => {
    const { service } = await build(() => Promise.resolve(fullDay.slice(0, -1))); // missing close bar
    await expect(service.run(req)).rejects.toThrow(UnprocessableEntityException);

    const { service: s2 } = await build(() => Promise.resolve(fullDay.slice(0, -1)));
    const forced = await s2.run({ ...req, allowIncomplete: true });
    expect(forced.coverage.complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- backtest.service`
Expected: FAIL — cannot find module `./backtest.service`.

- [ ] **Step 3: Write the implementation**

```ts
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ContractsService } from '../contracts/contracts.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ExecutionEngine } from './execution-engine';
import { RawOrder, normalizeOrders } from './orders';
import { SimResult, SimSummary } from './engine';
import { Interval, intervalToSeconds } from '../market-data/candle';
import { analyzeCoverage, CoverageResult } from '../market-data/coverage';
import { filterTimeWindow, hhmmToMinutes } from '../common/session-time';

export interface BacktestRequest {
  symbol: string;
  interval: Interval;
  date: string; // YYYY-MM-DD, ET calendar day
  session?: 'rth' | 'full';
  orders: RawOrder[];
  entryCutoff?: string; // 'HH:MM' or 'off'; default '14:00'
  openBuffer?: number;  // minutes after RTH open; default 30
  tz?: string;          // default contract timezone
  allowIncomplete?: boolean;
}

export interface BacktestResult {
  symbol: string;
  date: string;
  session: 'rth' | 'full';
  results: SimResult[];
  summary: SimSummary;
  coverage: CoverageResult;
}

function parseEntryCutoff(value: string): number | null {
  if (value === 'off' || value === 'none' || value === '') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) throw new Error('entryCutoff must be a 24-hour HH:MM time or "off"');
  return hour * 60 + minute;
}

@Injectable()
export class BacktestService {
  constructor(
    private readonly contracts: ContractsService,
    private readonly marketData: MarketDataService,
    private readonly engine: ExecutionEngine,
  ) {}

  async run(req: BacktestRequest): Promise<BacktestResult> {
    const spec = this.contracts.get(req.symbol); // 404 on unknown symbol
    const tz = req.tz ?? spec.timezone;
    const session = req.session ?? 'rth';
    const orders = normalizeOrders(req.orders);

    const dayCandles = await this.marketData.getDay(req.symbol, req.interval, req.date);
    if (dayCandles === null || dayCandles.length === 0) {
      throw new NotFoundException(`No stored candle data for ${req.symbol} ${req.interval} ${req.date}`);
    }

    const rthOpen = hhmmToMinutes(spec.rth.open);
    const rthClose = hhmmToMinutes(spec.rth.close);
    const coverage = analyzeCoverage(dayCandles, {
      openMin: rthOpen, closeMin: rthClose, intervalSec: intervalToSeconds(req.interval), tz,
    });

    if (session === 'rth' && !coverage.complete && req.allowIncomplete !== true) {
      throw new UnprocessableEntityException({
        error: 'incomplete-session',
        message: `Incomplete RTH session for ${req.symbol} ${req.date}; refusing to backtest`,
        hasOpen: coverage.hasOpen, hasClose: coverage.hasClose, gaps: coverage.gaps,
      });
    }

    const sessionCandles = session === 'rth' ? filterTimeWindow(dayCandles, tz, rthOpen, rthClose) : dayCandles;

    const openMinutes = rthOpen + (req.openBuffer ?? 30);
    const cutoffMinutes = parseEntryCutoff(req.entryCutoff ?? '14:00');

    const { results, summary } = this.engine.simulate(sessionCandles, orders, spec.pointValue, {
      openMinutes, cutoffMinutes, tz,
    });

    return { symbol: req.symbol, date: req.date, session, results, summary, coverage };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- backtest.service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/execution/backtest.service.ts src/execution/backtest.service.spec.ts
git commit -m "feat(execution): add BacktestService with coverage gate and orchestration"
```

### Task 16: BacktestController + ExecutionModule + wiring

**Files:**
- Create: `backend/src/execution/backtest.controller.ts`
- Create: `backend/src/execution/execution.module.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Write the controller**

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { BacktestRequest, BacktestResult, BacktestService } from './backtest.service';

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  @Post()
  async run(@Body() body: BacktestRequest): Promise<BacktestResult> {
    return this.backtest.run(body);
  }
}
```

- [ ] **Step 2: Write the module**

```ts
import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { ExecutionEngine } from './execution-engine';
import { BacktestService } from './backtest.service';

@Module({
  imports: [MarketDataModule],
  providers: [ExecutionEngine, BacktestService],
  exports: [ExecutionEngine, BacktestService],
})
export class ExecutionModule {}
```

- [ ] **Step 3: Wire into app.module.ts**

Modify `backend/src/app.module.ts`: add `import { ExecutionModule } from './execution/execution.module';` and `import { BacktestController } from './execution/backtest.controller';`. Add `ExecutionModule` to `imports` and `BacktestController` to `controllers`.

- [ ] **Step 4: Verify build + full unit suite**

Run: `pnpm build && pnpm test`
Expected: build succeeds; all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/execution/backtest.controller.ts src/execution/execution.module.ts src/app.module.ts
git commit -m "feat(execution): add POST /backtest endpoint and wire ExecutionModule"
```

### Task 17: Backtest e2e (happy path + 422 gate)

**Files:**
- Create: `backend/test/backtest.e2e-spec.ts`

- [ ] **Step 1: Write the e2e test**

Reuse the in-memory Firestore fake from `test/market-data.e2e-spec.ts` (copy the `fakeFirestore` helper, or extract it to `test/fake-firestore.ts` and import from both — prefer extracting to keep DRY).

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FIRESTORE } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';

describe('Backtest (e2e)', () => {
  let app: INestApplication;
  const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
  const fullCsv = ['time,open,high,low,close', ...Array.from({ length: 78 }, (_, i) => `${OPEN + i * 300},100,101,99,100`)].join('\n');
  const shortCsv = ['time,open,high,low,close', ...Array.from({ length: 77 }, (_, i) => `${OPEN + i * 300},100,101,99,100`)].join('\n');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE).useValue(fakeFirestore())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it('backtests a complete day', async () => {
    await request(app.getHttpServer()).post('/markets/MES/min-5/candles').attach('file', Buffer.from(fullCsv), 'mes.csv').expect(201);
    const res = await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'MES', interval: 'min-5', date: '2026-07-14', session: 'rth', orders: [{ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 }] })
      .expect(201);
    expect(res.body.coverage.complete).toBe(true);
    expect(res.body.summary.orders).toBe(1);
  });

  it('refuses an incomplete day with 422', async () => {
    await request(app.getHttpServer()).post('/markets/NQ/min-5/candles').attach('file', Buffer.from(shortCsv), 'nq.csv').expect(201);
    const res = await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'NQ', interval: 'min-5', date: '2026-07-14', orders: [{ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 }] })
      .expect(422);
    expect(res.body.error).toBe('incomplete-session');
  });
});
```

Extract the shared fake to `backend/test/fake-firestore.ts` (the `fakeFirestore` function body from Task 11) and update `market-data.e2e-spec.ts` to import it.

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm test:e2e`
Expected: PASS — all e2e specs green.

- [ ] **Step 3: Commit**

```bash
git add test/backtest.e2e-spec.ts test/fake-firestore.ts test/market-data.e2e-spec.ts
git commit -m "test(execution): e2e backtest happy path and incomplete-session gate"
```

### Task 18: Final verification + README

**Files:**
- Modify: `backend/README.md`

- [ ] **Step 1: Run the full suite**

Run: `pnpm build && pnpm test && pnpm test:e2e`
Expected: build clean; all unit + e2e tests pass.

- [ ] **Step 2: Document the new endpoints in README**

Add a "Market data & backtest" section to `backend/README.md` covering:
- `POST /markets/:symbol/:interval/candles` (multipart `file`, `?replace=true`) → ingest summary.
- `GET /markets/:symbol/:interval/days` → stored days with `complete`.
- `GET /markets/:symbol/:interval/candles?date=YYYY-MM-DD` → a day's candles.
- `POST /backtest` (JSON `BacktestRequest`) → results/summary/coverage; note the `422` incomplete-session gate and `allowIncomplete` escape hatch.
- Note supported symbols (MES/ES/NQ/MNQ) and intervals (min-1/5/15/60), and that half-days are excluded (flagged incomplete).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(backend): document market-data and backtest endpoints"
```

---

## Self-Review Notes (traceability to spec)

- Contract registry (spec §1) → Tasks 1–3.
- Doc-per-day Firestore layout + compact keys (spec §2) → Tasks 5, 8, 9.
- CSV OHLC-only parsing (spec §2) → Task 6.
- Idempotent per-day merge-upsert + `replace` + unchanged-skip (spec §2) → Task 9.
- Coverage/gap util, DST-safe algorithm (spec §2) → Task 7; stored at ingest (Task 9); enforced at backtest (Task 15).
- Multipart upload + read endpoints (spec §2) → Task 10; e2e Task 11.
- Pure engine + orders port, heavy unit tests (spec §3, §Testing) → Tasks 12–13.
- ExecutionEngine + BacktestService + coverage gate (spec §3) → Tasks 14–15.
- `POST /backtest` + wiring (spec §3) → Task 16; e2e Task 17.
- Error mapping 400/404/422 (spec §Error Handling) → validated across Tasks 8, 10, 15, 17.
- CLI untouched (spec §Non-Goals) → no `src/` changes anywhere in the plan.
```
