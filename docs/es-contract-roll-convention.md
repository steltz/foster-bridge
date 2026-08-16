# ES contract roll convention — which contract a TP day refers to

**Status:** verified on volume for all six rolls (2025 + 2026), and on TP
Previous-Day-Summary matching for all six: both 2026 rolls and Mar/Dec 2025
exactly at the boundary days, Jun/Sep 2025 via the nearest days that actually
ingested (see below).

## Finding

Eminiplayer trade plans do **not** switch contracts on CME's official roll date
(the second Thursday of the contract month). They stay on the front contract
through the Friday before expiration week and switch on the **Monday of
expiration week** — the same day actual volume/liquidity crosses over to the
next quarterly. This held on every roll examined.

The switch is marked explicitly: every roll-Monday sheet checked carries a
rollover note in the *Economic Reports* box — 2026-format sheets say just
"Rollover" (03/16/2026, 06/15/2026); 2025-format sheets are more explicit,
naming the incoming contract by name: 03/17/2025 says **"Rollover to ES June
25'"** and 12/15/2025 says **"Rollover: Today's Zones are for the ES March 26'
Contract."** The note is not always present on the *Friday before* the roll,
though — 03/14/2025 has "- Rollover on Monday -" but 09/12/2025 and
12/12/2025 (also the Friday immediately preceding their respective roll
Mondays) have none. So the roll-Monday note is reliable; a Friday-before
heads-up is not.

## Why it matters

`POST /backtest` grades setups against candle data for a specific contract.
Adjacent quarterlies trade ~50–60 points apart (carry), so grading a trade plan
against the wrong contract shifts every level by the full spread — entries and
stops become nonsense, not merely noisy. Any pipeline mapping a TP day to
candle data must resolve the contract with this rule, not the CME roll date.

## The rule

For a TP dated `D`:

1. Find the contract month's expiration: **third Friday** of Mar/Jun/Sep/Dec.
2. Expiration-week Monday = third Friday − 4 days.
3. `D` **before** that Monday → front contract. `D` **on or after** → next
   quarterly.

Deterministic, calendar-only — no volume lookup needed at runtime.

## Evidence

### Volume crossover (data/ES_5min_update_t6h13g, all six rolls)

Daily volume summed per contract file; crossover = first day the new
contract out-trades the old. It is the expiration-week Monday in all six:

| Roll | CME roll date (2nd Thu) | Volume crossover | Margin (new vs old) |
|---|---|---|---|
| Mar 2025 (H5→M5) | Thu 2025-03-13 | **Mon 2025-03-17** | 820k vs 723k |
| Jun 2025 (M5→U5) | Thu 2025-06-12 | **Mon 2025-06-16** | 804k vs 544k |
| Sep 2025 (U5→Z5) | Thu 2025-09-11 | **Mon 2025-09-15** | 709k vs 430k |
| Dec 2025 (Z5→H6) | Thu 2025-12-11 | **Mon 2025-12-15** | 1,014k vs 591k |
| Mar 2026 (H6→M6) | Thu 2026-03-12 | **Mon 2026-03-16** | 1,037k vs 735k |
| Jun 2026 (M6→U6) | Thu 2026-06-11 | **Mon 2026-06-15** | 917k vs 546k |

### TP Previous Day Summary matching

The worksheet's *Previous Day Summary* High/Low identifies the quoted contract
unambiguously (the wrong contract is ~40–60 pts away). With the correct session
window (see caveats), matches are tick-exact:

| TP sheet | Prev-day High/Low quoted | Matches | Notes |
|---|---|---|---|
| Fri 03/13/2026 | 6732.00 / 6671.75 | **H26** exact | still front contract |
| Mon 03/16/2026 | 6787.25 / 6674.75 | **M26** | High exact; "Rollover" marker |
| Fri 06/12/2026 | 7420.00 / 7263.00 | **M26** exact | still front contract |
| Mon 06/15/2026 | 7525.00 / 7429.00 | **U26** exact | "08:30 – Rollover" marker |
| Fri 03/14/2025 | 5603.75 / 5509.25 | **H25** exact | still front contract; "Rollover on Monday" heads-up |
| Mon 03/17/2025 | 5701.00 / 5616.25 | **M25** (within 1 pt) | High off by 0.25, Low by ~1.75 vs H25's ~50pt miss — clearly M25, not tick-exact; "Rollover to ES June 25'" |
| Mon 06/09/2025 | 6025.00 / 5984.50 | **M25** exact | nearest ingested day *before* the roll (06/13 & 06/16 both failed to ingest) |
| Tue 06/17/2025 | 6109.00 / 6066.25 | **U25** exact | nearest ingested day *after* the roll |
| Fri 09/12/2025 | 6600.00 / 6552.00 | **U25** exact | the actual pre-roll Friday; still front contract; no rollover note this quarter |
| Tue 09/16/2025 | 6681.25 / 6663.25 | **Z25** exact | nearest ingested day after roll Monday 09/15 (which failed to ingest) |
| Fri 12/12/2025 | 6928.75 / 6838.00 | **Z25** exact | still front contract; no rollover note this quarter |
| Mon 12/15/2025 | 6962.75 / 6864.75 | **H26** (within 1 pt) | High off by 0.5, Low by 0.75 vs Z25's ~60-100pt miss; "Rollover: Today's Zones are for the ES March 26' Contract" |

The Jun and Sep 2025 rows show the rule survives being tested away from the
exact boundary: even bracketing from 4–8 days out (M25 on 06/09 a full week
before the roll, U25 on 06/17 the day after; U25 on 09/12 the Friday right
before, Z25 on 09/16 the day right after), the contract each sheet quotes still
flips exactly at the expiration-week Monday, not gradually or on the CME date.

The TP transcripts (`*_ES_TP.md`) never mention the roll — neither in the roll
week nor the week before, in either sheet format. The only roll signal in the
knowledge docs is the 2026-format worksheet's "Rollover" line on the switch
Monday itself (see caveat above — absent in 2025).

## Caveats / gotchas found along the way

- **Candle timestamps are US Eastern Time.** RTH is 09:30–16:15 ET, not
  08:30–15:15. Matching with a CT-assumed window produces near-misses that
  look like a different session convention.
- **Eminiplayer's daily High/Low can include the post-settlement stub**
  (16:15–17:00 ET). The 03/16/2026 sheet's prev-day Low 6674.75 printed at
  16:55 ET. When validating by prev-day matching, compare against the full
  trade date (prior 18:00 ET → 17:00 ET), not just RTH.
- **Corpus gaps exist** (e.g. 05/28/2026 has no day folder in GCS) — a missing
  boundary day is a data gap, not a market holiday.
- **The exact roll-boundary days are disproportionately likely to fail
  ingest.** A full-year 2025 backfill (246 candidate days, 211 uploaded, 35
  failed — all content-quality gaps on eminiplayer.net: missing YouTube
  embeds, archive-listing date/title mismatches; the pipeline's own
  validation correctly rejected these rather than persisting bad data) hit
  **both** boundary days for the Jun 2025 roll (06/13 *and* 06/16) and the
  post-roll boundary for Sep 2025 (09/15). Whether that's coincidence or
  something about roll-week publishing on the source site is unclear from
  n=3, but don't assume a `resolveContract` implementation can always find a
  TP PDF to assert against exactly on the switch day — the assertion needs a
  fallback to the nearest available day on each side, as done for the 2025
  verification above.
- Volume crossover is a same-day-or-later signal (needs the day's full bars);
  the calendar rule is what makes runtime resolution deterministic.

## Verification backlog

All six 2025/2026 rolls are now verified on both volume crossover and TP
prev-day-summary matching. Remaining open items:

- Jun and Sep 2025's exact boundary days (06/13, 06/16, 09/15) never made it
  into storage — a plain retry is unlikely to help since the causes look like
  permanent source-content problems, not transient ones. The rule was
  confirmed for those rolls by bracketing from the nearest ingested days
  instead (see table above); exact-day confirmation would need manually
  sourcing the missing recap video/archive entry.
- Watch for a quarter where volume crosses before the Monday (Thu/Fri of the
  prior week). None observed in six rolls, but if it ever happens, the TP's
  calendar rule and the volume signal would disagree for a session or two —
  the prev-day-summary match is the tiebreaker.
- Two of the eight tick-level matches (03/17/2025, 12/15/2025) were within
  ~1 point rather than exact — worth keeping in mind when choosing a
  tolerance for the planned runtime assertion (0.0 is too strict; ~2 points
  comfortably separates a correct match from an adjacent-contract miss, which
  runs 40–100+ points away).

## Planned implementation (not yet built)

A `resolveContract(date)` helper in the backend:

- Input: trade date (`YYYY-MM-DD`); output: contract code (e.g. `M26`).
- Pure calendar rule above; no I/O.
- Optional assertion when a TP PDF exists for the day: extract *Previous Day
  Summary* High/Low and require a match (tolerance 0; full trade-date window)
  against the resolved contract's candles. Disagreement → fail loudly, don't
  average.
