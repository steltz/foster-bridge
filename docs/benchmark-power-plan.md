# Benchmark Statistical Plan — reaching a defensible answer on Seven-Keys variants

Written 2026-08-14, after the first full Kimi K3 run of the two Seven-Keys
variants across 14 days.

**One-line summary:** the K3 run completed cleanly (280/280 cells, $29.06) and
told us almost nothing, because 14 trading days cannot resolve the effect sizes
we care about. The fix is more *days*, not more runs per day. Getting to a real
answer costs roughly **$335 and ~35 hours**, and the binding constraint is
ingest throughput and wall clock, not model spend.

---

## 1. What was run

`POST /benchmark/run` with `model: kimi-k3`, variants
`seven-keys-method` + `seven-keys-scorecard`, all 14 complete days, 2 traders,
`runCount: 5`.

- **280 keys-variant cells** (140 per variant), plus the 140 `base` cells that
  already existed for the same 14 days.
- **14 KEYS artifacts** generated under the `k3` lineage, all `verified: true`.
  Kimi did not consume the existing Fable-generated keys, as designed — it
  bootstrapped its own lineage.
- **Total k3 spend: $29.06** — $22.40 setup cells (420 records), $6.66 keys
  generation (60 records).
- Drift guard clean throughout (456 cells examined, no findings).

### KEYS artifact quality

Spot-checked and sound. Artifacts live in **Firestore** (`dayArtifacts`,
doc id `<day>__keys__<alias>`), not GCS — the `gcsPath` field on KEYS docs is
metadata that points at a file which is never written (see §7).

Grade discrimination is working, which was the main failure mode to worry
about (a lazy generator marks everything `strong`):

| Day | Lookback sources | Zones | Grades |
|---|---|---|---|
| 07/01 | `[]` (bootstrap) | 29 | 18 weak / 7 moderate / 3 strong / 1 auto-fade |
| 07/02 | `[07/01]` | 27 | 18 / 6 / 2 / 1 |
| 07/06 | `[07/01, 07/02]` | 27 | 16 / 7 / 3 / 1 |

~65% land `weak`, exactly one `automatic-fade` per day, and the reasoning is
substantive — distant zones are graded down for unreachability even when their
confluence is excellent. Keys 1–2 are correctly withheld as trader-behaviour
keys, so `seven-keys-scorecard` tests *shared assessment*, not a full answer key.

---

## 2. Results (all 14 days)

### Pooled across traders

| Variant | Fill | Win rate | Avg R | Total R | Total pts |
|---|---|---|---|---|---|
| base | 58/140 (41%) | 20% | −0.13 | −7.07 | −1.75 |
| seven-keys-method | 48/140 (34%) | 11% | **−0.51** | **−23.40** | **−129.75** |
| seven-keys-scorecard | 39/140 (28%) | 24% | −0.05 | −2.02 | +21.50 |

### As standalone strategies (the decision-relevant view)

`R/day` = what you'd expect trading it **once per day**, averaging the 5 runs,
with an unfilled setup counted as 0R.

| Combo | Fill | Win | Avg R/trade | **R/day** | 14d total R | t vs 0 |
|---|---|---|---|---|---|---|
| context-trader / base | 40% | 26% | +0.08 | **+0.031** | **+0.44** | +0.15 |
| context-structured / scorecard | 27% | 28% | −0.00 | −0.000 | −0.00 | −0.00 |
| context-trader / scorecard | 29% | 20% | −0.10 | −0.029 | −0.40 | −0.12 |
| context-trader / method | 39% | 16% | −0.26 | −0.091 | −1.28 | −0.46 |
| context-structured / base | 43% | 15% | −0.34 | −0.132 | −1.85 | −0.67 |
| context-structured / method | 30% | 5% | −0.81 | −0.243 | −3.40 | −1.90 |

### Findings

1. **Nothing is significant.** All pairwise |t| ≤ 1.28. Only one of six combos
   is positive, at +0.44R over 14 days — a rounding error.
2. **One day is the whole dataset.** 07/09 produced +1.90/+0.60/+2.44/+1.80/
   +1.46/+2.80 across the six combos. **Remove 07/09 and every combo goes
   negative.** 5 of 14 days had zero fills for every variant.
3. **The one durable signal is negative:** `seven-keys-method` is worse than
   `base` for *both* personas (−0.243 vs −0.132; −0.091 vs +0.031). Giving the
   model the methodology *without* the shared artifact is worse than giving it
   nothing. This held at 8 days and strengthened at 14.
4. **Fill rate falls monotonically** — 41% → 34% → 28%. Every layer of
   Seven-Keys context makes the model pick tighter, less reachable entries.
   For `scorecard` that selectivity roughly pays for itself; for `method` it
   does not.
5. **`context-structured / scorecard` finishing at exactly −0.000R is
   inactivity, not quality** — 9 flat days out of 14, only 18 trades. It avoids
   the losses that sink `context-structured / base` largely by not trading.

> An earlier read at the 8-day mark showed `scorecard` profitable (+0.09R) and
> leading `base` by +0.31R. That did not survive the full 14 days: the edge
> collapsed to +0.08R (t = +0.21). It was small-sample noise.

---

## 3. Why 14 days could never have worked

### Variance decomposition

| Combo | sd between days | sd within day | ICC |
|---|---|---|---|
| context-structured / base | 0.735 | 0.789 | 0.46 |
| context-structured / method | 0.478 | 0.423 | 0.56 |
| context-structured / scorecard | 0.773 | 0.464 | 0.74 |
| context-trader / base | 0.751 | 0.985 | 0.37 |
| context-trader / method | 0.736 | 0.844 | 0.43 |
| context-trader / scorecard | 0.896 | 0.483 | **0.77** |

Most variance lives **between days**. Extra runs only divide the within-day
term:

```
SE = sqrt( sd_b²/D  +  sd_w²/(D·K) )        D = days, K = runs per day
```

Standard error of the R/day estimate (context-trader / scorecard):

| Days | K=1 | K=3 | K=5 | K=10 | K=20 |
|---|---|---|---|---|---|
| 14 | 0.272 | 0.251 | 0.246 | 0.243 | 0.241 |
| 60 | 0.131 | 0.121 | 0.119 | 0.117 | 0.117 |
| 283 | 0.061 | 0.056 | 0.055 | 0.054 | 0.054 |

**Going from 5 runs to 20 runs at 14 days moves SE from 0.246 to 0.241.**
Nothing. Worse, for a *fixed cell budget*, SE² = (K·sd_b² + sd_w²)/B, which is
minimised at **K=1** — extra runs on the same day actively cost power.

**The effective n was 14, not 70.**

### Minimum detectable effect at 14 days (80% power, α=0.05)

- Paired: **0.45 R/day**
- Absolute: **0.67 R/day**

Every effect we care about is 0.03–0.24 R/day. The study was underpowered by
3–10× in effect size, i.e. **10–100× in days**.

---

## 4. The design lever that already works: pairing

All variants run on **identical days**, so day effects cancel. Variant results
correlate 0.48–0.86 across days.

| Comparison | Mean diff | sd(diff) | corr | t |
|---|---|---|---|---|
| structured: scorecard − base | +0.132 | 0.399 | 0.86 | +1.24 |
| structured: scorecard − method | +0.243 | 0.562 | 0.69 | +1.62 |
| structured: method − base | −0.111 | 0.500 | 0.74 | −0.83 |
| trader: scorecard − base | −0.060 | 0.603 | 0.75 | −0.37 |
| trader: scorecard − method | +0.063 | 0.775 | 0.56 | +0.30 |
| trader: method − base | −0.122 | 0.761 | 0.48 | −0.60 |

Average paired sd = **0.600** vs unpaired ~**1.273**. Pairing needs only
**22% as many days**.

**Protect this.** Never compare a variant measured on one day set against a
variant measured on another — always run every variant across the full day set.

### Days required (paired, 80% power, α=0.05 two-sided)

| True edge (R/day) | Days | Trading weeks |
|---|---|---|
| 0.30 | 32 | 6 |
| **0.20** | **71** | **14** |
| 0.15 | 126 | 25 |
| 0.10 | 283 | 57 |
| 0.05 | 1,130 | 226 |

For **absolute** profitability of a single combo (vs zero, unpaired, sd 0.90):
0.20R → 159 days; 0.15R → 283; 0.10R → 636.

---

## 5. Costs

Measured unit costs from the $29.06 run:

- **Setup cell:** $22.40 ÷ 420 = **$0.053**
- **Keys generation:** $6.66 ÷ 14 = **$0.476/day** (once per day, shared across
  traders and run models)

Keys-generation cost is **flat per day at any history depth** — the lookback is
capped at the 3 most recent days (`seven-keys.service.ts:112`). No cost blowup
going back to 2018.

### Cost of the plan (base + scorecard, 2 traders, method dropped)

| Days | K=1 | **K=3** | K=5 |
|---|---|---|---|
| 71 *(detects 0.20R)* | $49 | **$79** | $109 |
| 126 *(detects 0.15R)* | $87 | **$141** | $194 |
| 283 *(detects 0.10R)* | $195 | **$316** | $436 |
| 504 *(~2 years)* | $347 | **$562** | $777 |
| 1,000 | $689 | **$1,116** | $1,542 |
| ~2,140 *(full 2018–2026)* | $1,474 | **$2,388** | $3,300 |

At K=3 that is **$1.12 per trading day**, all in.

### Wall clock is the real constraint

Keys generation ran at ~**7 minutes per day** and is **strictly sequential** —
day N reads the 3 most recent prior days, so it cannot start until N−1 lands.

| Days | Serial wall clock |
|---|---|
| 71 | ~8 hours |
| 283 | ~33 hours |
| 1,000 | ~5 days |
| 2,140 | **~10 days continuous** |

Ten days of unattended execution on a pipeline that wedged twice in twelve
hours is the actual risk — not the $2,400.

---

## 6. The plan

### Pre-registration (decide before collecting)

- **Primary comparison:** `context-trader`: `scorecard` − `base`, paired,
  endpoint **R/day with unfilled = 0R**, two-sided α = 0.05.
- **Everything else is exploratory** and must be labelled as such. Six combos ×
  three pairwise tests is ~18 chances at a false positive — which is exactly
  how 07/09 becomes a "finding".
- **Target effect:** +0.20 R/day is the threshold worth trading. Chasing
  0.10 R/day costs 283 days and probably isn't worth it.
- **Keep `unfilled = 0R` as primary.** Comparing only *filled* trades is
  post-treatment selection: variants have different fill rates (41/34/28%), so
  conditioning on fill biases toward whichever variant is pickiest. Per-trade R
  is secondary only.
- **No repeated peeking.** Analyse once at the target, or pre-specify a single
  interim look with an alpha-spending function.

### Scope changes

1. **Drop `seven-keys-method`.** It is the one settled result. Frees a third of
   every cell budget.
2. **`runCount: 5` → `3`.** Costs almost nothing in accuracy, cuts spend and
   wall clock, and reduces exposure to batch-layer failure.
3. **Run `base` + `scorecard` only**, both traders, across the full day set.

### Phases (with 2018-onward data available)

Do **not** run all 2,140 days. That resolves 0.04 R/day — far finer than
needed, at 30× the cost and time. The better use of eight years is *splitting*
it, which 14 days made impossible.

| Phase | Scope | Cost | Wall clock | Purpose |
|---|---|---|---|---|
| **1. Answer** | ~300 days, K=3, sampled **across years** not one contiguous block | ~$335 | ~35 h | Settles base vs scorecard at the 0.10 R/day level, across regimes |
| **2. Validate** | ~300 *different* days never examined during Phase 1 | ~$335 | ~35 h | Hold-out. Separates a real edge from one found by picking through results |
| **3. Robustness** | Slice by year (2018 / 2020 / 2024 …) | $0 (reuses data) | — | Does the edge survive regime change? |

**Total for a properly designed study: ~$700 and ~3 days of run time**, versus
$2,388 to brute-force everything at once and still have no hold-out.

Run Phase 2 **only if Phase 1 shows an edge**.

### Checkpoints

- At **~40 days**: sanity check. Look at the paired estimate's **confidence
  interval**, not its p-value.
- At **~300 days**: the real read.

### Expectation to set

A genuine possible outcome is **"the KEYS document does not meaningfully change
results."** That is a useful answer — it saves building on something that
doesn't work. Budget ~35% more calendar days than the tables say, since ~5/14
days produced zero fills for every variant and contributed no information.

---

## 7. Engineering prerequisites

### 7.1 Fix the batch-worker wedge — blocking

An unattended 35-hour run **will** hit this. It cost ~6 hours and one lost day
during the 14-day run.

`moonshot.batch-worker.ts:141`:

```js
async drainBatch(batchId) {
  if (this.active.has(batchId)) return;   // no-op if a prior drain never returned
  this.active.add(batchId);
  try { /* ... */ } finally { this.active.delete(batchId); }
}
```

`active` is an in-process set cleared only by the `finally`. **If a drain hangs,
that batch becomes permanently unreachable in that process.** The 30-minute
maintenance cron calls `resumeAll()` → `kick()` → `drainBatch()`, which returns
immediately and never reaches the expiry check on line 151 that would
force-terminate the batch. **No error is ever logged** — the batch just sits at
`in_progress` looking healthy.

Observed: two batches stalled with every item holding an expired lease,
re-claimable in principle, with nothing re-claiming them, while the Moonshot API
answered in 0.32s. Only a process restart cleared it.

Suggested fixes (any of):
- Time-bound entries in `active` (store a timestamp, treat stale entries as
  releasable) so a hung drain self-heals.
- Evaluate the `expiresAt` check **before** the `active` guard, so an expired
  batch always force-terminates regardless of drain state.
- Log at warn when `drainBatch` no-ops on the `active` guard — the silence is
  what made this take hours to find.

### 7.2 Parallel keys chains per year — recommended for full-history runs

The lookback chain is strictly sequential, which is what makes 2,140 days a
~10-day serial run. **Bootstrapping an independent keys chain per year removes
that.** Each year pays its own reduced-lookback warm-up on its first 3 days
(exactly what the `k3` lineage did on 07/01–07/06), and thereafter runs
normally.

That turns a ~10-day serial run into **under a day** with 8 years in parallel.

Caveat: the first ~3 days of each year have shallower calibration history than
a day mid-chain. Either accept it (it's 24 of 2,140 days) or discard each
chain's warm-up days from the analysis.

### 7.3 Smaller issues found

| Issue | Impact | Notes |
|---|---|---|
| `GET /ai/batch/:id` is hardwired to Anthropic | Debugging only | Rejects Moonshot `msb_` ids: *"Message Batch id must have `msgbatch_` prefix"*. Use `/benchmark/status` + `/costs/summary` instead. |
| `costs/summary?model=kimi-k3` returns **zero** records | Misleading | The cost store keys on the **alias** (`k3`), not the model id. An empty cost report is not evidence of no spend. |
| `gcsPath` on KEYS docs is a dangling reference | Cosmetic | `saveKeysArtifact` writes Firestore only; nothing is uploaded to that path. Harmless today (content is inlined) but misleads anyone who trusts the field. |
| Stale Anthropic batch `msgbatch_01Q1…` (07/22, 2 cells) | Log noise | Fails reconcile every 60s under `LLM_PROVIDER=moonshot`. Those 2 cells will never land until reconciled under an Anthropic provider. Pre-existing. |
| Force-terminated batches discard completed work | ~$1.50/incident | Day 07/15 lost 19 already-paid-for results; items are deliberately left untouched so the reconciler re-queues the whole batch. |
| Top-up races an in-flight batch | Silent gap | A day whose cells are in-flight doesn't read as "missing", so `POST /benchmark/run` skipped 07/15 while its batch was mid-flip to `errored`. Re-issuing after batches settle fixes it. |

---

## 8. Data-quality note

Day **07/15** was re-run from scratch after the batch wedge, so its cells come
from a different execution than the other 13 days. Same persona, same KEYS
artifact, same hashes, drift guard clean — sound, but it is the one day that did
not run in the original sequence.
