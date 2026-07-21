# Trader Scoreboard

462 cells · 3 trader@model@variant groups. Every group is scored alone; P&L is never combined across traders, models, or variants.

## Ranking (mean net USD per run)

| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | context-trader | sonnet | seven-keys-method | 11 | 14 | -27.32 | 92.82 | -173.75 | 108.75 | 22% | 44% |
| 2 | context-trader | sonnet | seven-keys-scorecard | 11 | 14 | -28.30 | 67.70 | -123.75 | 126.25 | 23% | 37% |
| 3 | context-trader | sonnet | base | 11 | 14 | -92.05 | 89.13 | -293.75 | 21.25 | 15% | 52% |

## Feature Impact

Each row compares base and feature over their shared day set only (the Days column); days covered by one side never bias Δ. Runs is base-vs-feature run counts over those days — a lopsided pair is a weakly sampled verdict. Pairs where either side has no filled trades over the shared days are omitted rather than scored zero. For combos, additional tables compare the combo against each of its components over the same shared-day rule.

### Seven-Keys methodology

| Trader | Model | Days | Runs | Base $/run | Seven-Keys methodology $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | sonnet | 11 | 14v14 | -92.05 | -27.32 | +64.73 |

**Overall Δ for Seven-Keys methodology across 1 trader/model pair: +64.73**
### Seven-Keys precomputed scorecard

| Trader | Model | Days | Runs | Base $/run | Seven-Keys precomputed scorecard $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | sonnet | 11 | 14v14 | -92.05 | -28.30 | +63.75 |

**Overall Δ for Seven-Keys precomputed scorecard across 1 trader/model pair: +63.75**

## Lineage

```
context-trader                 sonnet/base 14r: -92.05 · sonnet/seven-keys-method 14r: -27.32 · sonnet/seven-keys-scorecard 14r: -28.30
└─ context-structured
     Restructured the markdown into a numbered decision procedure with hard-constraints/heuristics split into separate sections, a worked numeric example, an explicit tie-break rule for conflicting bias signals, a confluence-to-minimum-R:R table in place of graduated prose, a pre-submit self-check checklist, and a contrastive anti-pattern example — the trading logic and rules are unchanged from context-trader.
```

## context-trader @ sonnet [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -1.25 | -6.25 |
| 2 | 11 | 1.25 | 6.25 |
| 3 | 11 | 13.25 | 66.25 |
| 4 | 11 | -7.25 | -36.25 |
| 5 | 11 | -34.75 | -173.75 |
| 6 | 11 | -33.75 | -168.75 |
| 7 | 11 | 6.75 | 33.75 |
| 8 | 11 | 21.75 | 108.75 |
| 9 | 11 | 8.25 | 41.25 |
| 10 | 11 | -16.5 | -82.50 |
| 11 | 11 | 19.75 | 98.75 |
| 12 | 11 | -10.25 | -51.25 |
| 13 | 11 | -24 | -120.00 |
| 14 | 11 | -19.75 | -98.75 |

Wins: 15 · Losses: 53 · Avg win: 32.90 pts · Avg loss: -10.75 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 14 | 14L/0S | 6.00 |
| 07022026 | 14 | 13L/1S | 128.75 |
| 07062026 | 14 | 14L/0S | 8.50 |
| 07072026 | 14 | 14L/0S | 84.75 |
| 07082026 | 14 | 14L/0S | 96.75 |
| 07092026 | 14 | 14L/0S | 6.00 |
| 07132026 | 14 | 14L/0S | 22.75 |
| 07142026 | 14 | 14L/0S | 82.75 |
| 07152026 | 14 | 14L/0S | 42.75 |
| 07162026 | 14 | 12L/2S | 71.25 |
| 07172026 | 14 | 8L/6S | 51.50 |

### Pipeline errors

None.

## context-trader @ sonnet [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -24.75 | -123.75 |
| 2 | 11 | -10.5 | -52.50 |
| 3 | 11 | -7 | -35.00 |
| 4 | 11 | -0.75 | -3.75 |
| 5 | 11 | -10 | -50.00 |
| 6 | 11 | -13.5 | -67.50 |
| 7 | 11 | -18 | -90.00 |
| 8 | 11 | -4.25 | -21.25 |
| 9 | 11 | 6.5 | 32.50 |
| 10 | 11 | 12.75 | 63.75 |
| 11 | 11 | -6.5 | -32.50 |
| 12 | 11 | 25.25 | 126.25 |
| 13 | 11 | -5.75 | -28.75 |
| 14 | 11 | -22.75 | -113.75 |

Wins: 13 · Losses: 44 · Avg win: 31.65 pts · Avg loss: -11.15 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 14 | 14L/0S | 32.50 |
| 07022026 | 14 | 14L/0S | 8.00 |
| 07062026 | 14 | 13L/1S | 141.25 |
| 07072026 | 14 | 14L/0S | 89.75 |
| 07082026 | 14 | 14L/0S | 91.50 |
| 07092026 | 14 | 14L/0S | 32.00 |
| 07132026 | 14 | 7L/7S | 122.50 |
| 07142026 | 14 | 9L/5S | 109.75 |
| 07152026 | 14 | 14L/0S | 3.00 |
| 07162026 | 14 | 13L/1S | 99.25 |
| 07172026 | 14 | 2L/12S | 64.25 |

### Pipeline errors

None.

## context-trader @ sonnet [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -19.5 | -97.50 |
| 2 | 11 | 4.25 | 21.25 |
| 3 | 11 | -11.25 | -56.25 |
| 4 | 11 | -16.25 | -81.25 |
| 5 | 11 | -6.75 | -33.75 |
| 6 | 11 | -34.25 | -171.25 |
| 7 | 11 | 3.25 | 16.25 |
| 8 | 11 | -58.75 | -293.75 |
| 9 | 11 | -25.75 | -128.75 |
| 10 | 11 | -18 | -90.00 |
| 11 | 11 | -13.25 | -66.25 |
| 12 | 11 | -15.5 | -77.50 |
| 13 | 11 | -1.25 | -6.25 |
| 14 | 11 | -44.75 | -223.75 |

Wins: 12 · Losses: 68 · Avg win: 31.67 pts · Avg loss: -9.38 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 14 | 14L/0S | 7.50 |
| 07022026 | 14 | 12L/2S | 131.00 |
| 07062026 | 14 | 13L/1S | 108.00 |
| 07072026 | 14 | 14L/0S | 83.75 |
| 07082026 | 14 | 14L/0S | 91.75 |
| 07092026 | 14 | 14L/0S | 7.50 |
| 07132026 | 14 | 12L/2S | 102.25 |
| 07142026 | 14 | 14L/0S | 4.00 |
| 07152026 | 14 | 14L/0S | 5.50 |
| 07162026 | 14 | 8L/6S | 99.75 |
| 07172026 | 14 | 11L/3S | 44.50 |

### Pipeline errors

None.

## Coverage

| Trader | Model | Variant | Cells | Days | Runs | Status |
|---|---|---|---|---|---|---|
| context-trader | sonnet | base | 154 | 11 | 14 | ok |
| context-trader | sonnet | seven-keys-method | 154 | 11 | 14 | ok |
| context-trader | sonnet | seven-keys-scorecard | 154 | 11 | 14 | ok |
