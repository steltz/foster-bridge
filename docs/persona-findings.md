# Persona Findings — what the 14-day K3 run revealed about the trader panel

Written 2026-08-14, from behavioral analysis of the 420 cells (2 traders × 3
variants × 14 days × 5 runs) in the Kimi K3 benchmark. Companion to
`benchmark-power-plan.md` (statistical design) — this doc covers what the data
says about the **personas themselves** and the harness boundary they run inside.

**One-line summary:** the current panel is one persona in two costumes, its
core R:R mandate operates in the losing region of the measured payoff curve,
and its entry rule inverts the methodology it is meant to express. The zone
*selection* shows genuine edge; the trade *construction* destroys it. Fixing
this is worth ~5–10× more R/day than the KEYS-variant question, at a fraction
of the sample size.

---

## 1. The two personas are one persona

`context-structured` is `context-trader` restructured (numbered procedure,
checklists, tie-break table) with the stated goal of lower run-to-run variance.
The data says it neither differs nor stabilizes:

- **Same picks:** across 41 day-variant pairs, same modal side **38/41 (93%)**,
  same modal zone **32/41 (78%)**. Day-level P&L correlation 0.75–0.86.
- **Failed its own goal:** on the `base` variant, side-unanimity across 5 runs
  was **7/14 days vs context-trader's 10/14**; zone-unanimity **1/14 vs 3/14**.
  The scaffolding made consistency *worse*. (Under `seven-keys-scorecard` it
  was marginally better, 8/14 vs 6/14 — but there the shared artifact does the
  stabilizing, not the persona structure.)

Every benchmark pays double to measure one strategy twice.

## 2. "Direction-agnostic" is not expressed

Both personas went long ~93% of the time (192/206 and 186/207 setups). The
direction machinery — tie-break rule, counter-trend caution — is inert in
practice. One of the persona's two core decisions contributes nothing
measurable.

## 3. The R:R mandate operates in the losing region (real-engine replay)

All 138 filled setups replayed through `POST /backtest` — same days, same
entries, same stops, **only the take-profit changed**:

| Target | Win rate | Total R |
|---|---|---|
| as-run (mandated ≥2.5:1) | 20% | **−32.5** |
| 3.0R | 20% | −28.2 |
| 2.0R | 33% | −4.2 |
| 1.5R | 48% | **+27.0** |
| 1.0R | 81% | **+86.0** |

Break-even sits near **2R**; the personas forbid anything under 2.5:1. The
swing is ~0.86R **per trade** on identical fills, and the 81% win rate at 1R is
spread across 11 days — structural, not one lucky session.

Supporting evidence that the zones themselves are good: **94% of stopped-out
trades moved ≥0.5R favorable before dying**; median favorable excursion of
losers **+1.33R**. Price reacts at the chosen zones — the bracket demands more
than the reaction delivers.

> **Caveat:** the target grid was searched on the same 14 days, so "1.0R" is
> in-sample-flattered. The robust part is the *shape* (monotonic, break-even
> ~2R). Pre-register a band (~1.5R) and validate on backfill days.

## 4. Ratio-first entries are adversely selected

The persona text instructs: *"a resting limit order at a price INSIDE your
chosen zone — **the price that delivers your target reward-to-risk**."* Entry
is derived from the ratio, which arithmetically forces entries deep into the
zone (median depth: **54%** of the way through). Outcome by entry depth:

| Entry depth into zone | n | Fill rate | Win rate | Avg R |
|---|---|---|---|---|
| shallow (0–33%) | 45 | 38% | 24% | **−0.02** |
| middle (33–66%) | 275 | 29% | 21% | −0.10 |
| deep (66–100%+) | 93 | **43%** | **10%** | **−0.59** |

Deep entries fill *more often* and win *far less* — the adverse-selection
signature. A limit resting deep in a zone fills preferentially on exactly the
occasions the zone is being cut through. Shallow entries sit near breakeven
**even under the 3:1 targets** (small n; treat as a hint).

## 5. The physics of a zone reaction

- Median zone width: **11.5 pts**. Median risk taken: **6.8 pts**.
- 3:1 on that risk demands **~20 pts** of favorable travel.
- Median favorable excursion of filled trades: **8.2 pts** — one zone width.

Reactions are real and zone-sized. The bracket asks a one-zone phenomenon to
travel three zones, with no mechanism to bank the one zone it gets.

## 6. Unfilled orders are not near-misses

59% of setups never filled. Median closest approach: **33 pts**; only 8% came
within 5 pts. The models rest orders at deep "exhausted" zones the market never
visits — encouraged by the persona text. 5 of 14 days produced zero fills for
every variant (pure cost, zero information).

## 7. The confidence field does not discriminate

Only values 3 (164) and 4 (249) ever appear. As elicited, it carries no
information. Fix the elicitation or drop the field.

---

## 8. Reconciling with the methodology's 3:1 doctrine

The trade-plan/Seven-Keys commentary preaches ~3:1 — and **nothing above
refutes the methodology**. The doctrine's 3:1 assumes two things the harness
does not do:

1. **Location first.** The discretionary trader enters at the first touch of a
   significant zone, near its edge; R:R follows from location. The persona
   inverted this (entry derived from the ratio → deep, adversely-selected
   fills).
2. **Active management.** A human whose 3R attempt dies at +1.4R scratches it,
   takes partials, or moves the stop to breakeven. The fire-and-forget bracket
   converts every "+1.4R then died" into a full −1R.

The fixed-target equivalent of "attempt 3:1 with management" is a much closer
target — which is why the replay curve pays at 1–1.5R. **The methodology can be
right for humans and unexpressible in the current harness simultaneously.**
Until the engine supports management primitives, every benchmark result is
about bracket-order *approximations* of the method, not the method itself.

---

## 9. Panel redesign (proposed)

Restart rather than mutate: the flaws are in the root, not the branches, and
restarting is nearly free — old files stay immutable, old cells keep meaning,
new files are new hashes/rows (no drift conflicts).

- **Root `zone-reaction`:** location-first entry (shallow in zone, first
  touch), stop behind the zone, target ~1.5R (the measured reaction size).
- **Mutant A — restore the doctrine ratio:** location-first entry, target at
  the next zone (accept the resulting R:R). Isolates the ratio question. If
  3:1 is right, this persona shows it.
- **Mutant B — depth axis:** deep/exhausted-zone preference vs first reachable
  zone (attacks the 59% no-fill).
- **Mutant C — direction axis:** with-bias-only vs free.
- **Retire `context-structured`** from future eras: duplicates picks, failed
  its purpose, doubles cost. Retirement = `git mv traders/<f>.md
  traders/retired/` — the benchmark reads only top-level files in `traders/`
  (`repo-inputs.service.ts:95`).

Panel discipline: 4–5 personas max, one axis per mutant, all benchmarked on
identical days (pairing), lineage frontmatter intact, hypotheses pre-registered
before running.

**Priority vs the variant question:** the KEYS-variant effect is ~0.1–0.2 R/day
(needs 71–283 paired days). The trade-construction effects above are ~0.5–0.9
R/day — detectable in ~20–30 paired days at trivial cost (4-persona panel on
14 existing days, K=3, base variant ≈ $9). Run the persona question first; then
re-ask the variant question on the winning persona (the scorecard's main
behavioral effect was fill selectivity, which interacts with all of this).

---

## 10. Harness gap: active trade management (open design question)

The engine's order model is entry/SL/TP only (`execution/orders.ts`), one shot,
no time dimension beyond `entryCutoff`. Candidate mechanisms under debate:

1. **Mechanical breakeven/trailing rules** on the order (e.g., stop → entry
   after +1R favorable excursion). Engine-level, deterministic, zero LLM cost —
   and retroactively testable against the 138 recorded fills.
2. **Intraday decision checkpoints** — persona sees a rendered summary of the
   session so far (from stored candles, strictly before the decision
   timestamp) at fixed points, rather than one pre-open shot.
3. **First-hour observation strategy** — no entry in the first RTH hour unless
   conviction is strong; otherwise observe the first hour, then place the
   order (needs an `activeFrom` order field and a first-hour summary renderer).

Key constraints for any of these: preserve Batch API economics where possible,
enforce a strict no-look-ahead convention (a decision may only see data
timestamped before it), and consider `min-1` candle ingest — breakeven
simulation sharpens the intra-candle ambiguity that `min-5` already carries.
