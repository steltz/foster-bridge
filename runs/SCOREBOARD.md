# Trader Scoreboard

990 cells · 6 trader@model@variant groups. Every group is scored alone; P&L is never combined across traders, models, or variants.

## Ranking (mean net USD per run)

| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | context-structured | sonnet | seven-keys-scorecard | 11 | 15 | -1.58 | 85.98 | -148.75 | 150.00 | 25% | 32% |
| 2 | context-trader | sonnet | seven-keys-method | 11 | 15 | -23.67 | 90.56 | -173.75 | 108.75 | 23% | 42% |
| 3 | context-structured | sonnet | seven-keys-method | 11 | 15 | -32.58 | 100.18 | -231.25 | 168.75 | 20% | 40% |
| 4 | context-trader | sonnet | seven-keys-scorecard | 11 | 15 | -39.17 | 77.63 | -191.25 | 126.25 | 22% | 36% |
| 5 | context-trader | sonnet | base | 11 | 15 | -90.33 | 86.15 | -293.75 | 21.25 | 16% | 53% |
| 6 | context-structured | sonnet | base | 11 | 15 | -101.42 | 70.02 | -197.50 | 43.75 | 17% | 46% |

## Feature Impact

Each row compares base and feature over their shared day set only (the Days column); days covered by one side never bias Δ. Runs is base-vs-feature run counts over those days — a lopsided pair is a weakly sampled verdict. Pairs where either side has no filled trades over the shared days are omitted rather than scored zero. For combos, additional tables compare the combo against each of its components over the same shared-day rule.

### Seven-Keys methodology

| Trader | Model | Days | Runs | Base $/run | Seven-Keys methodology $/run | Δ |
|---|---|---|---|---|---|---|
| context-structured | sonnet | 11 | 15v15 | -101.42 | -32.58 | +68.83 |
| context-trader | sonnet | 11 | 15v15 | -90.33 | -23.67 | +66.67 |

**Overall Δ for Seven-Keys methodology across 2 trader/model pairs: +67.75**
### Seven-Keys precomputed scorecard

| Trader | Model | Days | Runs | Base $/run | Seven-Keys precomputed scorecard $/run | Δ |
|---|---|---|---|---|---|---|
| context-structured | sonnet | 11 | 15v15 | -101.42 | -1.58 | +99.83 |
| context-trader | sonnet | 11 | 15v15 | -90.33 | -39.17 | +51.17 |

**Overall Δ for Seven-Keys precomputed scorecard across 2 trader/model pairs: +75.50**

## Lineage

```
context-trader                 sonnet/base 15r: -90.33 · sonnet/seven-keys-method 15r: -23.67 · sonnet/seven-keys-scorecard 15r: -39.17
└─ context-structured          sonnet/base 15r: -101.42 (Δ vs origin: -11.08) · sonnet/seven-keys-method 15r: -32.58 (Δ vs origin: -8.92) · sonnet/seven-keys-scorecard 15r: -1.58 (Δ vs origin: +37.58)
     Restructured the markdown into a numbered decision procedure with hard-constraints/heuristics split into separate sections, a worked numeric example, an explicit tie-break rule for conflicting bias signals, a confluence-to-minimum-R:R table in place of graduated prose, a pre-submit self-check checklist, and a contrastive anti-pattern example — the trading logic and rules are unchanged from context-trader.
```

## context-structured @ sonnet [seven-keys-scorecard]

Origin: context-trader — Restructured the markdown into a numbered decision procedure with hard-constraints/heuristics split into separate sections, a worked numeric example, an explicit tie-break rule for conflicting bias signals, a confluence-to-minimum-R:R table in place of graduated prose, a pre-submit self-check checklist, and a contrastive anti-pattern example — the trading logic and rules are unchanged from context-trader. · Δ mean $/run vs origin @ sonnet/seven-keys-scorecard: +37.58

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -28.25 | -141.25 |
| 2 | 11 | -29.75 | -148.75 |
| 3 | 11 | 14.25 | 71.25 |
| 4 | 11 | -10.75 | -53.75 |
| 5 | 11 | -4 | -20.00 |
| 6 | 11 | 10.75 | 53.75 |
| 7 | 11 | -1.75 | -8.75 |
| 8 | 11 | 30 | 150.00 |
| 9 | 11 | 4.25 | 21.25 |
| 10 | 11 | -10.5 | -52.50 |
| 11 | 11 | 13 | 65.00 |
| 12 | 11 | 6.75 | 33.75 |
| 13 | 11 | 8 | 40.00 |
| 14 | 11 | 15 | 75.00 |
| 15 | 11 | -21.75 | -108.75 |

Wins: 13 · Losses: 39 · Avg win: 30.10 pts · Avg loss: -10.15 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 15 | 15L/0S | 29.50 |
| 07022026 | 15 | 15L/0S | 8.25 |
| 07062026 | 15 | 15L/0S | 10.25 |
| 07072026 | 15 | 15L/0S | 89.25 |
| 07082026 | 15 | 13L/2S | 201.25 |
| 07092026 | 15 | 15L/0S | 25.75 |
| 07132026 | 15 | 8L/7S | 119.75 |
| 07142026 | 15 | 13L/2S | 107.25 |
| 07152026 | 15 | 15L/0S | 6.75 |
| 07162026 | 15 | 15L/0S | 52.50 |
| 07172026 | 15 | 3L/12S | 71.75 |

### Pipeline errors

None.

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
| 15 | 11 | 5.5 | 27.50 |

Wins: 16 · Losses: 54 · Avg win: 31.78 pts · Avg loss: -10.73 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 15 | 15L/0S | 6.00 |
| 07022026 | 15 | 13L/2S | 128.75 |
| 07062026 | 15 | 15L/0S | 8.50 |
| 07072026 | 15 | 15L/0S | 84.75 |
| 07082026 | 15 | 15L/0S | 96.75 |
| 07092026 | 15 | 15L/0S | 7.00 |
| 07132026 | 15 | 15L/0S | 22.75 |
| 07142026 | 15 | 15L/0S | 85.75 |
| 07152026 | 15 | 15L/0S | 42.75 |
| 07162026 | 15 | 13L/2S | 71.25 |
| 07172026 | 15 | 9L/6S | 51.50 |

### Pipeline errors

None.

## context-structured @ sonnet [seven-keys-method]

Origin: context-trader — Restructured the markdown into a numbered decision procedure with hard-constraints/heuristics split into separate sections, a worked numeric example, an explicit tie-break rule for conflicting bias signals, a confluence-to-minimum-R:R table in place of graduated prose, a pre-submit self-check checklist, and a contrastive anti-pattern example — the trading logic and rules are unchanged from context-trader. · Δ mean $/run vs origin @ sonnet/seven-keys-method: -8.92

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -18.5 | -92.50 |
| 2 | 11 | -9.5 | -47.50 |
| 3 | 11 | 8.75 | 43.75 |
| 4 | 11 | -12.25 | -61.25 |
| 5 | 11 | -46.25 | -231.25 |
| 6 | 11 | -13.25 | -66.25 |
| 7 | 11 | 33.75 | 168.75 |
| 8 | 11 | 10.75 | 53.75 |
| 9 | 11 | -29.25 | -146.25 |
| 10 | 11 | 1.25 | 6.25 |
| 11 | 11 | -4.5 | -22.50 |
| 12 | 11 | -3.25 | -16.25 |
| 13 | 11 | 15.5 | 77.50 |
| 14 | 11 | -1 | -5.00 |
| 15 | 11 | -30 | -150.00 |

Wins: 13 · Losses: 53 · Avg win: 31.23 pts · Avg loss: -9.50 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 15 | 15L/0S | 7.50 |
| 07022026 | 15 | 14L/1S | 129.50 |
| 07062026 | 15 | 15L/0S | 9.75 |
| 07072026 | 15 | 15L/0S | 86.75 |
| 07082026 | 15 | 15L/0S | 96.25 |
| 07092026 | 15 | 15L/0S | 30.25 |
| 07132026 | 15 | 12L/3S | 119.25 |
| 07142026 | 15 | 15L/0S | 29.75 |
| 07152026 | 15 | 15L/0S | 46.75 |
| 07162026 | 15 | 14L/1S | 73.25 |
| 07172026 | 15 | 3L/12S | 84.00 |

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
| 15 | 11 | -38.25 | -191.25 |

Wins: 13 · Losses: 47 · Avg win: 31.65 pts · Avg loss: -11.26 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 15 | 15L/0S | 32.50 |
| 07022026 | 15 | 15L/0S | 8.00 |
| 07062026 | 15 | 14L/1S | 141.25 |
| 07072026 | 15 | 15L/0S | 89.75 |
| 07082026 | 15 | 15L/0S | 91.75 |
| 07092026 | 15 | 15L/0S | 32.00 |
| 07132026 | 15 | 8L/7S | 122.50 |
| 07142026 | 15 | 10L/5S | 109.75 |
| 07152026 | 15 | 15L/0S | 3.00 |
| 07162026 | 15 | 14L/1S | 99.25 |
| 07172026 | 15 | 2L/13S | 64.25 |

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
| 15 | 11 | -13.25 | -66.25 |

Wins: 14 · Losses: 73 · Avg win: 30.29 pts · Avg loss: -9.52 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 15 | 15L/0S | 7.50 |
| 07022026 | 15 | 13L/2S | 131.00 |
| 07062026 | 15 | 14L/1S | 108.00 |
| 07072026 | 15 | 15L/0S | 83.75 |
| 07082026 | 15 | 15L/0S | 91.75 |
| 07092026 | 15 | 15L/0S | 7.50 |
| 07132026 | 15 | 13L/2S | 102.25 |
| 07142026 | 15 | 15L/0S | 5.75 |
| 07152026 | 15 | 15L/0S | 5.50 |
| 07162026 | 15 | 9L/6S | 99.75 |
| 07172026 | 15 | 11L/4S | 46.00 |

### Pipeline errors

None.

## context-structured @ sonnet [base]

Origin: context-trader — Restructured the markdown into a numbered decision procedure with hard-constraints/heuristics split into separate sections, a worked numeric example, an explicit tie-break rule for conflicting bias signals, a confluence-to-minimum-R:R table in place of graduated prose, a pre-submit self-check checklist, and a contrastive anti-pattern example — the trading logic and rules are unchanged from context-trader. · Δ mean $/run vs origin @ sonnet/base: -11.08

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -39.5 | -197.50 |
| 2 | 11 | -33.75 | -168.75 |
| 3 | 11 | -19.25 | -96.25 |
| 4 | 11 | -13.75 | -68.75 |
| 5 | 11 | -34.5 | -172.50 |
| 6 | 11 | -25.75 | -128.75 |
| 7 | 11 | 8.75 | 43.75 |
| 8 | 11 | -19.75 | -98.75 |
| 9 | 11 | -6.75 | -33.75 |
| 10 | 11 | -27.5 | -137.50 |
| 11 | 11 | -14.75 | -73.75 |
| 12 | 11 | -31 | -155.00 |
| 13 | 11 | -9.75 | -48.75 |
| 14 | 11 | -35.5 | -177.50 |
| 15 | 11 | -1.5 | -7.50 |

Wins: 13 · Losses: 63 · Avg win: 21.19 pts · Avg loss: -9.20 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 15 | 15L/0S | 7.50 |
| 07022026 | 15 | 15L/0S | 69.75 |
| 07062026 | 15 | 15L/0S | 9.25 |
| 07072026 | 15 | 15L/0S | 83.75 |
| 07082026 | 15 | 15L/0S | 97.25 |
| 07092026 | 15 | 15L/0S | 6.50 |
| 07132026 | 15 | 12L/3S | 111.50 |
| 07142026 | 15 | 15L/0S | 28.25 |
| 07152026 | 15 | 15L/0S | 47.75 |
| 07162026 | 15 | 7L/8S | 101.50 |
| 07172026 | 15 | 8L/7S | 86.00 |

### Pipeline errors

None.

## Coverage

| Trader | Model | Variant | Cells | Days | Runs | Status |
|---|---|---|---|---|---|---|
| context-structured | sonnet | base | 165 | 11 | 15 | ok |
| context-structured | sonnet | seven-keys-method | 165 | 11 | 15 | ok |
| context-structured | sonnet | seven-keys-scorecard | 165 | 11 | 15 | ok |
| context-trader | sonnet | base | 165 | 11 | 15 | ok |
| context-trader | sonnet | seven-keys-method | 165 | 11 | 15 | ok |
| context-trader | sonnet | seven-keys-scorecard | 165 | 11 | 15 | ok |
