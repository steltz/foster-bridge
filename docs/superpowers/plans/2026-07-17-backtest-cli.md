# Backtest CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Node CLI that replays one day of 5-minute OHLC candles against a list of long/short orders (entry, stop loss, take profit) and reports fills, exits, and P/L.

**Architecture:** Thin CLI (`src/cli.js`) wires five pure modules: CSV parsing, order validation, timezone-aware day filtering, a pure simulation engine, and output formatting. The engine takes arrays in and returns results out — no I/O — so it can be reused for other timeframes and batch runs later.

**Tech Stack:** Node 20+ built-ins only — `util.parseArgs`, `node:test`, `node:assert`, `Intl.DateTimeFormat`. ESM modules. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-17-backtest-cli-design.md`

**Simulation rules (from spec):** touch = fill (fill at entry price when a candle's low–high range contains it); after fill, every candle including the fill candle is checked for exit; SL checked before TP (worst case wins); open positions force-close at the last candle's close (`EOD`); untouched orders are `NOT_FILLED`.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "foster-bridge",
  "version": "0.1.0",
  "description": "CLI backtester for candlestick OHLC data",
  "type": "module",
  "bin": { "backtest": "./src/cli.js" },
  "scripts": { "test": "node --test" },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
```

- [ ] **Step 3: Verify the test runner works (no tests yet is fine)**

Run: `npm test`
Expected: exits successfully (Node 20/22 prints a summary with `tests 0` or `pass 0`; some versions exit 1 when zero test files exist — either outcome is acceptable at this step).

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: scaffold node project"
```

---

### Task 2: CSV parser

**Files:**
- Create: `src/parse-csv.js`
- Test: `test/parse-csv.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/parse-csv.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/parse-csv.js';

const HEADER = 'time,open,high,low,close,Some Indicator,@valuewhen';

test('parses required columns and ignores extra columns', () => {
  const text = [
    HEADER,
    '1782876900,7527.75,7531.75,7527.75,7531.25,junk,',
    '1782877200,7531.25,7531.75,7529,7529.5,,',
  ].join('\n');
  const candles = parseCsv(text);
  assert.deepEqual(candles, [
    { time: 1782876900, open: 7527.75, high: 7531.75, low: 7527.75, close: 7531.25 },
    { time: 1782877200, open: 7531.25, high: 7531.75, low: 7529, close: 7529.5 },
  ]);
});

test('sorts candles by time ascending', () => {
  const text = [
    HEADER,
    '200,2,2,2,2,,',
    '100,1,1,1,1,,',
  ].join('\n');
  const candles = parseCsv(text);
  assert.deepEqual(candles.map((c) => c.time), [100, 200]);
});

test('skips blank lines', () => {
  const text = `${HEADER}\n\n100,1,2,0.5,1.5,,\n\n`;
  assert.equal(parseCsv(text).length, 1);
});

test('rejects a missing required column', () => {
  assert.throws(
    () => parseCsv('time,open,high,low\n100,1,2,0.5'),
    /missing required column: close/
  );
});

test('rejects a non-numeric value with the line number', () => {
  const text = `${HEADER}\n100,1,2,0.5,1.5,,\n200,1,abc,0.5,1.5,,`;
  assert.throws(() => parseCsv(text), /line 3: invalid high/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/parse-csv.test.js`
Expected: FAIL — `Cannot find module .../src/parse-csv.js`

- [ ] **Step 3: Write the implementation**

Create `src/parse-csv.js`:

```js
const REQUIRED = ['time', 'open', 'high', 'low', 'close'];

// Parses TradingView-style CSV text into candle objects, ignoring any
// indicator columns beyond the required OHLC set.
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') rows.push({ lineNumber: i + 1, cols: lines[i].split(',') });
  }
  if (rows.length < 2) throw new Error('CSV has no data rows');

  const header = rows[0].cols.map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const name of REQUIRED) {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV missing required column: ${name}`);
    idx[name] = i;
  }

  const candles = rows.slice(1).map(({ lineNumber, cols }) => {
    const candle = {};
    for (const name of REQUIRED) {
      const value = Number(cols[idx[name]]);
      if (!Number.isFinite(value)) {
        throw new Error(`CSV line ${lineNumber}: invalid ${name} value "${cols[idx[name]] ?? ''}"`);
      }
      candle[name] = value;
    }
    return candle;
  });
  candles.sort((a, b) => a.time - b.time);
  return candles;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/parse-csv.test.js`
Expected: PASS — 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/parse-csv.js test/parse-csv.test.js
git commit -m "feat: parse OHLC candles from TradingView CSV"
```

---

### Task 3: Order validation

**Files:**
- Create: `src/orders.js`
- Test: `test/orders.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/orders.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrders } from '../src/orders.js';

test('normalizes a valid long and short with defaults', () => {
  const orders = normalizeOrders([
    { side: 'long', entry: 7530, stopLoss: 7520, takeProfit: 7550 },
    { id: 'fade', side: 'short', entry: 7560, stopLoss: 7570, takeProfit: 7540, qty: 2 },
  ]);
  assert.deepEqual(orders, [
    { id: 'long-1', side: 'long', entry: 7530, stopLoss: 7520, takeProfit: 7550, qty: 1 },
    { id: 'fade', side: 'short', entry: 7560, stopLoss: 7570, takeProfit: 7540, qty: 2 },
  ]);
});

test('rejects non-array input', () => {
  assert.throws(() => normalizeOrders({}), /must be a JSON array/);
});

test('rejects an invalid side', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'buy', entry: 1, stopLoss: 0, takeProfit: 2 }]),
    /Order 1: side must be "long" or "short"/
  );
});

test('rejects a non-numeric field', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'long', entry: '7530', stopLoss: 7520, takeProfit: 7550 }]),
    /Order 1: entry must be a number/
  );
});

test('rejects a long with SL/TP on the wrong side of entry', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'long', entry: 7530, stopLoss: 7540, takeProfit: 7550 }]),
    /long requires stopLoss < entry < takeProfit/
  );
});

test('rejects a short with SL/TP on the wrong side of entry', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'short', entry: 7530, stopLoss: 7520, takeProfit: 7510 }]),
    /short requires takeProfit < entry < stopLoss/
  );
});

test('rejects a bad qty', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'long', entry: 1, stopLoss: 0, takeProfit: 2, qty: 0 }]),
    /qty must be a positive integer/
  );
});

test('rejects duplicate ids', () => {
  assert.throws(
    () => normalizeOrders([
      { id: 'a', side: 'long', entry: 1, stopLoss: 0, takeProfit: 2 },
      { id: 'a', side: 'long', entry: 1, stopLoss: 0, takeProfit: 2 },
    ]),
    /Duplicate order id: "a"/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/orders.test.js`
Expected: FAIL — `Cannot find module .../src/orders.js`

- [ ] **Step 3: Write the implementation**

Create `src/orders.js`:

```js
// Validates raw parsed-JSON orders and fills in defaults (id, qty).
export function normalizeOrders(raw) {
  if (!Array.isArray(raw)) throw new Error('Orders file must be a JSON array');
  const counters = { long: 0, short: 0 };
  const seen = new Set();

  return raw.map((order, i) => {
    const where = `Order ${i + 1}`;
    if (order === null || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error(`${where}: must be an object`);
    }
    const { side } = order;
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
    counters[side] += 1;
    const id = order.id === undefined ? `${side}-${counters[side]}` : String(order.id);
    if (seen.has(id)) throw new Error(`Duplicate order id: "${id}"`);
    seen.add(id);
    return { id, side, entry, stopLoss, takeProfit, qty };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/orders.test.js`
Expected: PASS — 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/orders.js test/orders.test.js
git commit -m "feat: validate and normalize orders JSON"
```

---

### Task 4: Session (day) filtering

**Files:**
- Create: `src/session.js`
- Test: `test/session.test.js`

Timestamp facts used by the tests: `1782876900` = 2026-07-01T03:35:00Z, which is
2026-06-30 23:35 in `America/New_York` (EDT, UTC-4) — so the New York date and
the UTC date differ for the same instant.

- [ ] **Step 1: Write the failing tests**

Create `test/session.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateForTimestamp, latestDate, filterDay } from '../src/session.js';

test('converts a unix timestamp to a calendar date in a timezone', () => {
  assert.equal(dateForTimestamp(1782876900, 'America/New_York'), '2026-06-30');
  assert.equal(dateForTimestamp(1782876900, 'UTC'), '2026-07-01');
});

test('latestDate returns the date of the last candle', () => {
  const candles = [{ time: 1782876900 }, { time: 1782876900 + 86400 }];
  assert.equal(latestDate(candles, 'UTC'), '2026-07-02');
});

test('filterDay keeps only candles on the given date', () => {
  const candles = [
    { time: 1782876900 },            // 2026-06-30 NY
    { time: 1782876900 + 300 },      // 2026-06-30 NY
    { time: 1782876900 + 86400 },    // 2026-07-01 NY
  ];
  const day = filterDay(candles, '2026-06-30', 'America/New_York');
  assert.deepEqual(day.map((c) => c.time), [1782876900, 1782877200]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL — `Cannot find module .../src/session.js`

- [ ] **Step 3: Write the implementation**

Create `src/session.js`:

```js
const formatters = new Map();

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    );
  }
  return formatters.get(tz);
}

// en-CA locale formats as YYYY-MM-DD.
export function dateForTimestamp(unixSeconds, tz) {
  return formatterFor(tz).format(new Date(unixSeconds * 1000));
}

export function latestDate(candles, tz) {
  return dateForTimestamp(candles[candles.length - 1].time, tz);
}

export function filterDay(candles, date, tz) {
  return candles.filter((c) => dateForTimestamp(c.time, tz) === date);
}
```

Note: an invalid `tz` makes `Intl.DateTimeFormat` throw a `RangeError`; the CLI's
top-level catch (Task 7) turns that into a stderr message and exit 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: PASS — 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/session.test.js
git commit -m "feat: timezone-aware session day filtering"
```

---

### Task 5: Simulation engine

**Files:**
- Create: `src/engine.js`
- Test: `test/engine.test.js`

This is the core. Exit rules, in order of precedence per candle: SL first
(worst case), then TP. The fill candle itself is checked for exits.

- [ ] **Step 1: Write the failing tests**

Create `test/engine.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateOrder, simulate } from '../src/engine.js';

// Candle shorthand: c(time, open, high, low, close)
const c = (time, open, high, low, close) => ({ time, open, high, low, close });

const longOrder = { id: 'l', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 };
const shortOrder = { id: 's', side: 'short', entry: 100, stopLoss: 105, takeProfit: 90, qty: 1 };

test('order never touched is NOT_FILLED', () => {
  const candles = [c(1, 120, 125, 115, 120)];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
  });
});

test('long fills on touch then exits at take profit', () => {
  const candles = [
    c(1, 101, 102, 100, 101),  // low touches entry 100 -> fill
    c(2, 101, 111, 101, 110),  // high >= 110 -> TP
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 2, exitPrice: 110,
  });
});

test('long exits at stop loss', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 102, 94, 95),    // low <= 95 -> SL
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'SL', fillTime: 1, exitTime: 2, exitPrice: 95,
  });
});

test('candle spanning both SL and TP resolves to SL (worst case)', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 111, 94, 108),   // spans both 95 and 110
  ];
  assert.equal(simulateOrder(longOrder, candles).status, 'SL');
});

test('fill and exit can happen on the same candle', () => {
  const candles = [c(1, 108, 111, 100, 110)]; // touches entry 100 AND high >= 110
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 1, exitPrice: 110,
  });
});

test('position open at end of day closes at last close as EOD', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 104, 99, 103),
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'EOD', fillTime: 1, exitTime: 2, exitPrice: 103,
  });
});

test('short exits at take profit when price falls', () => {
  const candles = [
    c(1, 99, 101, 98, 99),     // touches entry 100 -> fill
    c(2, 99, 99, 89, 90),      // low <= 90 -> TP
  ];
  assert.deepEqual(simulateOrder(shortOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 2, exitPrice: 90,
  });
});

test('short exits at stop loss when price rises', () => {
  const candles = [
    c(1, 99, 101, 98, 99),
    c(2, 99, 106, 99, 105),    // high >= 105 -> SL
  ];
  assert.deepEqual(simulateOrder(shortOrder, candles), {
    status: 'SL', fillTime: 1, exitTime: 2, exitPrice: 105,
  });
});

test('simulate computes P/L and summary', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 111, 101, 110),  // long TP at 110
  ];
  const orders = [
    longOrder,                                                             // +10 pts
    { id: 'q2', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, qty: 2 }, // +20 pts
    { id: 'miss', side: 'long', entry: 50, stopLoss: 45, takeProfit: 60, qty: 1 }, // not filled
  ];
  const { results, summary } = simulate(candles, orders, 5);
  assert.equal(results[0].points, 10);
  assert.equal(results[0].dollars, 50);
  assert.equal(results[1].points, 20);
  assert.equal(results[1].dollars, 100);
  assert.equal(results[2].status, 'NOT_FILLED');
  assert.equal(results[2].points, null);
  assert.deepEqual(summary, {
    orders: 3, filled: 2, wins: 2, losses: 0, netPoints: 30, netDollars: 150,
  });
});

test('a losing short counts as a loss in the summary', () => {
  const candles = [
    c(1, 99, 101, 98, 99),
    c(2, 99, 106, 99, 105),    // short SL at 105 -> -5 pts
  ];
  const { results, summary } = simulate(candles, [shortOrder], 5);
  assert.equal(results[0].points, -5);
  assert.equal(results[0].dollars, -25);
  assert.deepEqual(summary, {
    orders: 1, filled: 1, wins: 0, losses: 1, netPoints: -5, netDollars: -25,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — `Cannot find module .../src/engine.js`

- [ ] **Step 3: Write the implementation**

Create `src/engine.js`:

```js
// Replays candles chronologically for a single order.
// Rules (see spec): touch = fill at entry price; the fill candle itself is
// checked for exits; SL is checked before TP so an ambiguous candle that
// spans both resolves to the worst case; still-open positions close at the
// final candle's close (EOD).
export function simulateOrder(order, candles) {
  const { side, entry, stopLoss, takeProfit } = order;
  let fillTime = null;

  for (const candle of candles) {
    if (fillTime === null) {
      if (candle.low <= entry && entry <= candle.high) {
        fillTime = candle.time;
      } else {
        continue;
      }
    }
    const slHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss;
    if (slHit) return { status: 'SL', fillTime, exitTime: candle.time, exitPrice: stopLoss };

    const tpHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (tpHit) return { status: 'TP', fillTime, exitTime: candle.time, exitPrice: takeProfit };
  }

  if (fillTime === null) {
    return { status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null };
  }
  const last = candles[candles.length - 1];
  return { status: 'EOD', fillTime, exitTime: last.time, exitPrice: last.close };
}

export function simulate(candles, orders, multiplier) {
  const results = orders.map((order) => {
    const outcome = simulateOrder(order, candles);
    let points = null;
    let dollars = null;
    if (outcome.status !== 'NOT_FILLED') {
      const direction = order.side === 'long' ? 1 : -1;
      points = (outcome.exitPrice - order.entry) * direction * order.qty;
      dollars = points * multiplier;
    }
    return { ...order, ...outcome, points, dollars };
  });

  const filled = results.filter((r) => r.status !== 'NOT_FILLED');
  const summary = {
    orders: results.length,
    filled: filled.length,
    wins: filled.filter((r) => r.points > 0).length,
    losses: filled.filter((r) => r.points < 0).length,
    netPoints: filled.reduce((sum, r) => sum + r.points, 0),
    netDollars: filled.reduce((sum, r) => sum + r.dollars, 0),
  };
  return { results, summary };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS — 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/engine.js test/engine.test.js
git commit -m "feat: pure order simulation engine"
```

---

### Task 6: Report formatting

**Files:**
- Create: `src/report.js`
- Test: `test/report.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/report.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTable } from '../src/report.js';

const payload = {
  session: '2026-06-30',
  results: [
    {
      id: 'long-1', side: 'long', status: 'TP', qty: 1,
      entry: 100, stopLoss: 95, takeProfit: 110,
      fillTime: 1782876900, exitTime: 1782877200, exitPrice: 110,
      points: 10, dollars: 50,
    },
    {
      id: 'miss', side: 'short', status: 'NOT_FILLED', qty: 1,
      entry: 200, stopLoss: 210, takeProfit: 190,
      fillTime: null, exitTime: null, exitPrice: null,
      points: null, dollars: null,
    },
  ],
  summary: { orders: 2, filled: 1, wins: 1, losses: 0, netPoints: 10, netDollars: 50 },
};

test('formats a session header, order rows, and summary', () => {
  const out = formatTable(payload, 'America/New_York');
  assert.match(out, /Session: 2026-06-30/);
  assert.match(out, /ID\s+SIDE\s+STATUS\s+FILL\s+EXIT\s+EXIT PX\s+PTS\s+USD/);
  // 1782876900 = 23:35 New York, 1782877200 = 23:40
  assert.match(out, /long-1\s+long\s+TP\s+23:35\s+23:40\s+110\s+10\.00\s+50\.00/);
  assert.match(out, /miss\s+short\s+NOT_FILLED\s+-\s+-\s+-\s+-\s+-/);
  assert.match(out, /Orders: 2 {2}Filled: 1 {2}Wins: 1 {2}Losses: 0/);
  assert.match(out, /Net: 10\.00 pts {2}\$50\.00/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/report.test.js`
Expected: FAIL — `Cannot find module .../src/report.js`

- [ ] **Step 3: Write the implementation**

Create `src/report.js`:

```js
const timeFormatters = new Map();

function formatTime(unixSeconds, tz) {
  if (unixSeconds === null) return '-';
  if (!timeFormatters.has(tz)) {
    timeFormatters.set(
      tz,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    );
  }
  return timeFormatters.get(tz).format(new Date(unixSeconds * 1000));
}

export function formatTable({ session, results, summary }, tz) {
  const headers = ['ID', 'SIDE', 'STATUS', 'FILL', 'EXIT', 'EXIT PX', 'PTS', 'USD'];
  const rows = results.map((r) => [
    r.id,
    r.side,
    r.status,
    formatTime(r.fillTime, tz),
    formatTime(r.exitTime, tz),
    r.exitPrice === null ? '-' : String(r.exitPrice),
    r.points === null ? '-' : r.points.toFixed(2),
    r.dollars === null ? '-' : r.dollars.toFixed(2),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  return [
    `Session: ${session}`,
    '',
    line(headers),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    `Orders: ${summary.orders}  Filled: ${summary.filled}  Wins: ${summary.wins}  Losses: ${summary.losses}`,
    `Net: ${summary.netPoints.toFixed(2)} pts  $${summary.netDollars.toFixed(2)}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/report.test.js`
Expected: PASS — 1 test passes

- [ ] **Step 5: Commit**

```bash
git add src/report.js test/report.test.js
git commit -m "feat: table report formatting"
```

---

### Task 7: CLI wiring and end-to-end test

**Files:**
- Create: `src/cli.js`
- Create: `test/fixtures/chart.csv`
- Create: `test/fixtures/orders.json`
- Test: `test/cli.test.js`

- [ ] **Step 1: Create the fixtures**

Create `test/fixtures/chart.csv` (all four candles fall on 2026-06-30 in
America/New_York and 2026-07-01 in UTC):

```
time,open,high,low,close,Some Indicator
1782876900,100,105,99,104,x
1782877200,104,110,103,109,x
1782877500,109,112,108,111,x
1782877800,111,113,110,112,x
```

Create `test/fixtures/orders.json`:

```json
[
  { "id": "win", "side": "long", "entry": 100, "stopLoss": 95, "takeProfit": 110 },
  { "id": "miss", "side": "long", "entry": 90, "stopLoss": 85, "takeProfit": 95 }
]
```

Expected outcome: `win` fills on candle 1 (99–105 touches 100), takes profit on
candle 2 (high 110), +10 pts / +$50. `miss` is never touched (day low is 99).

- [ ] **Step 2: Write the failing end-to-end tests**

Create `test/cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const chart = fileURLToPath(new URL('./fixtures/chart.csv', import.meta.url));
const ordersFile = fileURLToPath(new URL('./fixtures/orders.json', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('runs a backtest and emits JSON results', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.session, '2026-06-30');
  assert.equal(out.orders.length, 2);
  assert.equal(out.orders[0].id, 'win');
  assert.equal(out.orders[0].status, 'TP');
  assert.equal(out.orders[0].points, 10);
  assert.equal(out.orders[0].dollars, 50);
  assert.equal(out.orders[1].status, 'NOT_FILLED');
  assert.deepEqual(out.summary, {
    orders: 2, filled: 1, wins: 1, losses: 0, netPoints: 10, netDollars: 50,
  });
});

test('default output is the human-readable table', () => {
  const proc = run(['--data', chart, '--orders', ordersFile]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Session: 2026-06-30/);
  assert.match(proc.stdout, /win\s+long\s+TP/);
  assert.match(proc.stdout, /Net: 10\.00 pts {2}\$50\.00/);
});

test('respects --tz for session selection', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--tz', 'UTC', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).session, '2026-07-01');
});

test('errors on a --date with no candles', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--date', '2020-01-01']);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /No candles found for 2020-01-01/);
});

test('errors on a missing data file', () => {
  const proc = run(['--data', 'nope.csv', '--orders', ordersFile]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /nope\.csv/);
});

test('errors when required flags are missing', () => {
  const proc = run([]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /Usage:/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — cli.js does not exist, so every spawn exits non-zero / stdout is empty

- [ ] **Step 4: Write the implementation**

Create `src/cli.js`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCsv } from './parse-csv.js';
import { normalizeOrders } from './orders.js';
import { filterDay, latestDate } from './session.js';
import { simulate } from './engine.js';
import { formatTable } from './report.js';

const USAGE =
  'Usage: backtest --data <chart.csv> --orders <orders.json> ' +
  '[--date YYYY-MM-DD] [--tz <IANA timezone>] [--multiplier <n>] [--json]';

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      data: { type: 'string' },
      orders: { type: 'string' },
      date: { type: 'string' },
      tz: { type: 'string', default: 'America/New_York' },
      multiplier: { type: 'string', default: '5' },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values.data || !values.orders) throw new Error(USAGE);
  const multiplier = Number(values.multiplier);
  if (!Number.isFinite(multiplier)) throw new Error('--multiplier must be a number');
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    throw new Error('--date must be YYYY-MM-DD');
  }

  const candles = parseCsv(readFileSync(values.data, 'utf8'));

  let rawOrders;
  try {
    rawOrders = JSON.parse(readFileSync(values.orders, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read orders file: ${err.message}`);
  }
  const orders = normalizeOrders(rawOrders);

  const session = values.date ?? latestDate(candles, values.tz);
  const dayCandles = filterDay(candles, session, values.tz);
  if (dayCandles.length === 0) {
    throw new Error(`No candles found for ${session} (${values.tz})`);
  }

  const { results, summary } = simulate(dayCandles, orders, multiplier);

  if (values.json) {
    console.log(JSON.stringify({ session, orders: results, summary }, null, 2));
  } else {
    console.log(formatTable({ session, results, summary }, values.tz));
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 5: Run the e2e tests to verify they pass**

Run: `node --test test/cli.test.js`
Expected: PASS — 6 tests pass

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green (parse-csv 5, orders 8, session 3, engine 10, report 1, cli 6 = 33 tests)

- [ ] **Step 7: Smoke-test against the real MES data**

Create a throwaway `orders.json` in the project root (do not commit it — this is
a manual check, not a fixture):

```json
[
  { "side": "long", "entry": 7510, "stopLoss": 7505, "takeProfit": 7520 },
  { "side": "short", "entry": 7512, "stopLoss": 7517, "takeProfit": 7500 }
]
```

Run:

```bash
node src/cli.js --data "ticker-data/MES/min-5/CME_MINI_MES1!, 5.csv" --orders orders.json
```

Expected: a table for the latest session in the file with plausible fills
against real prices (exact results depend on the data — verify statuses and
that P/L signs make sense, e.g. a TP long shows positive points). Then delete
the throwaway file: `rm orders.json`.

- [ ] **Step 8: Commit**

```bash
git add src/cli.js test/cli.test.js test/fixtures/chart.csv test/fixtures/orders.json
git commit -m "feat: backtest CLI entry point with e2e tests"
```
