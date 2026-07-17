# YouTube Transcript Subcommand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `backtest transcript <youtube-url>` — fetch a public YouTube video's transcript via the `youtube-transcript` npm package and print it as timestamped markdown (or `--json` segments).

**Architecture:** `src/cli.js` becomes a thin dispatcher on `argv[2]` (`run` | `transcript` | flag-style back-compat → `run`). The existing backtest flow moves verbatim into `src/run-command.js`. New pure formatting logic lives in `src/transcript.js`; `src/transcript-command.js` parses flags and calls the package through an injectable fetch function so tests never touch the network.

**Tech Stack:** Node 20+ ESM, `node:test`, `util.parseArgs`; first runtime dependency: `youtube-transcript` (pinned exact version).

**Spec:** `docs/superpowers/specs/2026-07-17-youtube-transcript-command-design.md`

---

### Task 1: Install dependency and probe offset units

**Files:**
- Modify: `package.json` (adds `dependencies`)
- Create: `package-lock.json` (generated)

- [ ] **Step 1: Install the package, pinned exactly**

```bash
npm install --save-exact youtube-transcript
```

Expected: `package.json` gains a `"dependencies": { "youtube-transcript": "<x.y.z>" }` block with an exact version (no `^`); `package-lock.json` created; `node_modules/` appears (already gitignored). Record the exact version for your report.

- [ ] **Step 2: Live probe — determine the offset unit**

The package's `offset`/`duration` fields have historically flip-flopped between seconds and milliseconds across versions. Determine the unit empirically (network required; this is the one live step):

```bash
node -e "import('youtube-transcript').then(async (m) => {
  const t = await m.YoutubeTranscript.fetchTranscript('dQw4w9WgXcQ');
  console.log(JSON.stringify(t.slice(0, 3), null, 2));
  console.log('segments:', t.length);
})"
```

Interpretation: this video's first caption starts within the first minute. If the early `offset` values are small numbers (< 60) they are **seconds**; if they are large (thousands+) they are **milliseconds**. Record which, plus a sample segment, in your report — Task 4 sets `OFFSET_DIVISOR` from this (seconds → `1`, milliseconds → `1000`). Also note the exact shape of a segment object (expected keys: `text`, `duration`, `offset`, possibly `lang`).

If the probe fails with a fetch/parse error, STOP and report BLOCKED with the error — that means the package is currently broken against YouTube and the feature decision needs revisiting.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add youtube-transcript dependency"
```

---

### Task 2: Pure transcript formatting module

**Files:**
- Create: `src/transcript.js`
- Test: `test/transcript.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/transcript.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, formatOffset, transcriptToMarkdown } from '../src/transcript.js';

test('formatOffset renders zero-padded MM:SS below one hour', () => {
  assert.equal(formatOffset(0), '00:00');
  assert.equal(formatOffset(7), '00:07');
  assert.equal(formatOffset(83.4), '01:23');
  assert.equal(formatOffset(3599), '59:59');
});

test('formatOffset grows to H:MM:SS at one hour', () => {
  assert.equal(formatOffset(3600), '1:00:00');
  assert.equal(formatOffset(3725), '1:02:05');
});

test('decodeEntities handles common and double-encoded entities', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &#39;live&#39;'), "Tom & Jerry 'live'");
  assert.equal(decodeEntities('&amp;#39;quoted&amp;#39;'), "'quoted'");
  assert.equal(decodeEntities('&lt;b&gt; &quot;hi&quot;'), '<b> "hi"');
});

test('transcriptToMarkdown renders header and lines, skips empty segments', () => {
  const md = transcriptToMarkdown([
    { text: ' first ', offset: 0, duration: 5 },
    { text: '   ', offset: 3, duration: 2 },
    { text: 'second&#39;s', offset: 83, duration: 4 },
  ]);
  assert.equal(md, "# Transcript\n\n**00:00** first\n**01:23** second's\n");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/transcript.test.js`
Expected: FAIL — `Cannot find module .../src/transcript.js`

- [ ] **Step 3: Write the implementation**

Create `src/transcript.js`:

```js
// Decodes the entities YouTube captions actually contain. &amp; is decoded
// FIRST so double-encoded forms like &amp;#39; unwrap fully to an apostrophe.
export function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Seconds -> "MM:SS", or "H:MM:SS" from one hour up.
export function formatOffset(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function transcriptToMarkdown(segments) {
  const lines = [];
  for (const seg of segments) {
    const text = decodeEntities(String(seg.text ?? '')).trim();
    if (!text) continue;
    lines.push(`**${formatOffset(seg.offset)}** ${text}`);
  }
  return `# Transcript\n\n${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/transcript.test.js`
Expected: PASS — 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/transcript.js test/transcript.test.js
git commit -m "feat: pure transcript formatting module"
```

---

### Task 3: Dispatcher refactor (run subcommand + back-compat)

**Files:**
- Create: `src/run-command.js`
- Modify: `src/cli.js` (full rewrite to dispatcher)
- Modify: `test/cli.test.js` (two new tests appended)

- [ ] **Step 1: Append the failing dispatcher tests**

Append to the END of `test/cli.test.js` (leave all existing tests untouched):

```js
test('explicit run subcommand works', () => {
  const proc = run(['run', '--data', chart, '--orders', ordersFile, '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).session, '2026-06-30');
});

test('unknown command errors with usage', () => {
  const proc = run(['bogus']);
  assert.equal(proc.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc.stderr, /Unknown command "bogus"/);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/cli.test.js`
Expected: 6 existing pass; `explicit run subcommand works` FAILS (`run` is not a flag, parseArgs rejects it → exit 1); `unknown command errors with usage` FAILS (message doesn't match yet).

- [ ] **Step 3: Move the backtest flow into `src/run-command.js`**

Create `src/run-command.js` — this is the existing `src/cli.js` try-block, changed only to (a) be an exported function taking `args`, (b) mention `[run]` in USAGE:

```js
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCsv } from './parse-csv.js';
import { normalizeOrders } from './orders.js';
import { filterDay, latestDate } from './session.js';
import { simulate } from './engine.js';
import { formatTable } from './report.js';

const USAGE =
  'Usage: backtest [run] --data <chart.csv> --orders <orders.json> ' +
  '[--date YYYY-MM-DD] [--tz <IANA timezone>] [--multiplier <n>] [--json]';

export function runBacktest(args) {
  const { values } = parseArgs({
    args,
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
}
```

- [ ] **Step 4: Rewrite `src/cli.js` as the dispatcher**

Replace the entire contents of `src/cli.js` with:

```js
#!/usr/bin/env node
import { runBacktest } from './run-command.js';

const USAGE =
  'Usage: backtest <command> ...\n' +
  'Commands:\n' +
  '  run         Backtest orders against OHLC data (default when flags are given)\n' +
  '  transcript  Fetch a YouTube video transcript as markdown';

try {
  const argv = process.argv.slice(2);
  const [first, ...rest] = argv;
  if (first === 'run') {
    runBacktest(rest);
  } else if (first === undefined || first.startsWith('--')) {
    runBacktest(argv); // back-compat: flag-style invocation means "run"
  } else {
    throw new Error(`Unknown command "${first}"\n${USAGE}`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

(The `transcript` branch is added in Task 4 — the usage text already advertises it, and until then it falls into the unknown-command error, which is acceptable mid-plan but is why Tasks 3 and 4 should merge to main together.)

- [ ] **Step 5: Run the cli tests**

Run: `node --test test/cli.test.js`
Expected: PASS — 8 tests (6 existing including flag-style back-compat, plus the 2 new)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — 46 tests (40 existing + 4 from Task 2 + 2 new), 0 fail

- [ ] **Step 7: Commit**

```bash
git add src/cli.js src/run-command.js test/cli.test.js
git commit -m "refactor: split CLI into subcommand dispatcher and run command"
```

---

### Task 4: Transcript command with injectable fetcher

**Files:**
- Create: `src/transcript-command.js`
- Modify: `src/cli.js` (add transcript branch)
- Test: `test/transcript-command.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/transcript-command.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTranscript, OFFSET_DIVISOR } from '../src/transcript-command.js';

// Capture everything the command writes to stdout.
function captureStdout() {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  return { text: () => chunks.join(''), restore: () => { process.stdout.write = original; } };
}

test('prints markdown from fetched segments', async () => {
  const cap = captureStdout();
  try {
    await runTranscript(['https://youtu.be/abc123xyz00'], {
      fetchTranscript: async () => [
        { text: 'hello', offset: 0 * OFFSET_DIVISOR, duration: 2 * OFFSET_DIVISOR },
        { text: 'world&#39;s', offset: 83 * OFFSET_DIVISOR, duration: 3 * OFFSET_DIVISOR },
      ],
    });
  } finally {
    cap.restore();
  }
  assert.equal(cap.text(), "# Transcript\n\n**00:00** hello\n**01:23** world's\n");
});

test('--json prints segments normalized to seconds', async () => {
  const cap = captureStdout();
  try {
    await runTranscript(['abc123xyz00', '--json'], {
      fetchTranscript: async () => [
        { text: 'hi', offset: 5 * OFFSET_DIVISOR, duration: 2 * OFFSET_DIVISOR },
      ],
    });
  } finally {
    cap.restore();
  }
  assert.deepEqual(JSON.parse(cap.text()), [{ text: 'hi', offset: 5, duration: 2 }]);
});

test('missing url argument throws the transcript usage', async () => {
  await assert.rejects(() => runTranscript([]), /Usage: backtest transcript/);
});

test('fetch failures are wrapped with a clear message', async () => {
  await assert.rejects(
    () =>
      runTranscript(['abc123xyz00'], {
        fetchTranscript: async () => {
          throw new Error('Transcript is disabled on this video');
        },
      }),
    /Could not fetch transcript: Transcript is disabled on this video/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/transcript-command.test.js`
Expected: FAIL — `Cannot find module .../src/transcript-command.js`

- [ ] **Step 3: Write the implementation**

Create `src/transcript-command.js`. **Set `OFFSET_DIVISOR` from Task 1's probe:** `1` if the package returned seconds, `1000` if milliseconds — and state the probed package version in the comment:

```js
import { parseArgs } from 'node:util';
import { transcriptToMarkdown } from './transcript.js';

const USAGE = 'Usage: backtest transcript <youtube-url-or-id> [--json]';

// youtube-transcript@<version from Task 1> returns offsets in <unit from Task 1
// probe>; this divisor normalizes them to seconds at the command boundary so
// src/transcript.js always works in seconds.
export const OFFSET_DIVISOR = 1;

async function defaultFetch(urlOrId) {
  const { YoutubeTranscript } = await import('youtube-transcript');
  return YoutubeTranscript.fetchTranscript(urlOrId);
}

export async function runTranscript(args, { fetchTranscript = defaultFetch } = {}) {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const target = positionals[0]?.trim();
  if (!target) throw new Error(USAGE);

  let raw;
  try {
    raw = await fetchTranscript(target);
  } catch (err) {
    throw new Error(`Could not fetch transcript: ${err.message}`);
  }

  const segments = raw.map((seg) => ({
    text: seg.text,
    offset: seg.offset / OFFSET_DIVISOR,
    duration: seg.duration / OFFSET_DIVISOR,
  }));

  if (values.json) {
    process.stdout.write(`${JSON.stringify(segments, null, 2)}\n`);
  } else {
    process.stdout.write(transcriptToMarkdown(segments));
  }
}
```

- [ ] **Step 4: Wire the dispatcher**

In `src/cli.js`, add the import and the `transcript` branch (the file becomes):

```js
#!/usr/bin/env node
import { runBacktest } from './run-command.js';
import { runTranscript } from './transcript-command.js';

const USAGE =
  'Usage: backtest <command> ...\n' +
  'Commands:\n' +
  '  run         Backtest orders against OHLC data (default when flags are given)\n' +
  '  transcript  Fetch a YouTube video transcript as markdown';

try {
  const argv = process.argv.slice(2);
  const [first, ...rest] = argv;
  if (first === 'transcript') {
    await runTranscript(rest);
  } else if (first === 'run') {
    runBacktest(rest);
  } else if (first === undefined || first.startsWith('--')) {
    runBacktest(argv); // back-compat: flag-style invocation means "run"
  } else {
    throw new Error(`Unknown command "${first}"\n${USAGE}`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 5: Run the new tests, then the full suite**

Run: `node --test test/transcript-command.test.js`
Expected: PASS — 4 tests

Run: `npm test`
Expected: PASS — 50 tests (46 after Task 3 + 4 new), 0 fail

- [ ] **Step 6: Live smoke test**

Run (network required):

```bash
node src/cli.js transcript dQw4w9WgXcQ | head -8
node src/cli.js transcript 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' --json | head -12
```

Expected: markdown starting `# Transcript` with `**MM:SS**`-stamped caption lines whose timestamps are plausible (first under a minute, increasing); JSON mode shows `offset` values in seconds consistent with those timestamps. Also verify a clean failure:

```bash
node src/cli.js transcript not-a-real-video-id-12345; echo "exit=$?"
```

Expected: one stderr line starting `Could not fetch transcript:` and `exit=1`. Include all three outputs in your report.

- [ ] **Step 7: Commit**

```bash
git add src/transcript-command.js src/cli.js test/transcript-command.test.js
git commit -m "feat: youtube transcript subcommand"
```
