# Trader Scoreboard

924 cells · 6 trader@model@variant groups. Every group is scored alone; P&L is never combined across traders, models, or variants.

## Ranking (mean net USD per run)

| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | context-trader | sonnet | seven-keys-method | 11 | 14 | -27.32 | 92.82 | -173.75 | 108.75 | 22% | 44% |
| 2 | context-trader | sonnet | seven-keys-scorecard | 11 | 14 | -28.30 | 67.70 | -123.75 | 126.25 | 23% | 37% |
| 3 | placement-trader | sonnet | seven-keys-scorecard | 11 | 14 | -50.71 | 133.50 | -293.75 | 198.75 | 22% | 70% |
| 4 | placement-trader | sonnet | seven-keys-method | 11 | 14 | -63.21 | 123.56 | -331.25 | 123.75 | 18% | 60% |
| 5 | placement-trader | sonnet | base | 11 | 14 | -67.59 | 60.32 | -147.50 | 43.75 | 16% | 59% |
| 6 | context-trader | sonnet | base | 11 | 14 | -92.05 | 89.13 | -293.75 | 21.25 | 15% | 52% |

## Feature Impact

Each row compares base and feature over their shared day set only (the Days column); days covered by one side never bias Δ. Runs is base-vs-feature run counts over those days — a lopsided pair is a weakly sampled verdict. Pairs where either side has no filled trades over the shared days are omitted rather than scored zero. For combos, additional tables compare the combo against each of its components over the same shared-day rule.

### Seven-Keys methodology

| Trader | Model | Days | Runs | Base $/run | Seven-Keys methodology $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | sonnet | 11 | 14v14 | -92.05 | -27.32 | +64.73 |
| placement-trader | sonnet | 11 | 14v14 | -67.59 | -63.21 | +4.37 |

**Overall Δ for Seven-Keys methodology across 2 trader/model pairs: +34.55**
### Seven-Keys precomputed scorecard

| Trader | Model | Days | Runs | Base $/run | Seven-Keys precomputed scorecard $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | sonnet | 11 | 14v14 | -92.05 | -28.30 | +63.75 |
| placement-trader | sonnet | 11 | 14v14 | -67.59 | -50.71 | +16.87 |

**Overall Δ for Seven-Keys precomputed scorecard across 2 trader/model pairs: +40.31**

## Lineage

```
context-trader                 sonnet/base 14r: -92.05 · sonnet/seven-keys-method 14r: -27.32 · sonnet/seven-keys-scorecard 14r: -28.30
placement-trader               sonnet/base 14r: -67.59 · sonnet/seven-keys-method 14r: -63.21 · sonnet/seven-keys-scorecard 14r: -50.71
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

## placement-trader @ sonnet [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -58.75 | -293.75 |
| 2 | 11 | 39.75 | 198.75 |
| 3 | 11 | -33.5 | -167.50 |
| 4 | 11 | -31.5 | -157.50 |
| 5 | 11 | -34.75 | -173.75 |
| 6 | 11 | 9.5 | 47.50 |
| 7 | 11 | -15 | -75.00 |
| 8 | 11 | -35.25 | -176.25 |
| 9 | 11 | -9.75 | -48.75 |
| 10 | 11 | 10.25 | 51.25 |
| 11 | 11 | -13.5 | -67.50 |
| 12 | 11 | 4.5 | 22.50 |
| 13 | 11 | 7.75 | 38.75 |
| 14 | 11 | 18.25 | 91.25 |

Wins: 24 · Losses: 84 · Avg win: 30.25 pts · Avg loss: -10.33 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 14 | 14L/0S | 24.75 |
| 07022026 | 14 | 14L/0S | 59.00 |
| 07062026 | 14 | 13L/1S | 106.25 |
| 07072026 | 14 | 14L/0S | 9.75 |
| 07082026 | 14 | 13L/1S | 63.75 |
| 07092026 | 14 | 14L/0S | 3.75 |
| 07132026 | 14 | 7L/7S | 96.75 |
| 07142026 | 14 | 9L/5S | 37.25 |
| 07152026 | 14 | 14L/0S | 40.00 |
| 07162026 | 14 | 14L/0S | 0.75 |
| 07172026 | 14 | 0L/14S | 1.25 |

### Pipeline errors

None.

## placement-trader @ sonnet [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -3.75 | -18.75 |
| 2 | 11 | 11.5 | 57.50 |
| 3 | 11 | 23.75 | 118.75 |
| 4 | 11 | -20.75 | -103.75 |
| 5 | 11 | -31 | -155.00 |
| 6 | 11 | 24.75 | 123.75 |
| 7 | 11 | -17 | -85.00 |
| 8 | 11 | 0.5 | 2.50 |
| 9 | 11 | -15.5 | -77.50 |
| 10 | 11 | -28.25 | -141.25 |
| 11 | 11 | -10.25 | -51.25 |
| 12 | 11 | -4.5 | -22.50 |
| 13 | 11 | -66.25 | -331.25 |
| 14 | 11 | -40.25 | -201.25 |

Wins: 17 · Losses: 76 · Avg win: 37.24 pts · Avg loss: -10.66 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 14 | 14L/0S | 25.00 |
| 07022026 | 14 | 13L/1S | 121.75 |
| 07062026 | 14 | 14L/0S | 51.00 |
| 07072026 | 14 | 14L/0S | 30.75 |
| 07082026 | 14 | 14L/0S | 0.75 |
| 07092026 | 14 | 14L/0S | 9.75 |
| 07132026 | 14 | 14L/0S | 44.75 |
| 07142026 | 14 | 14L/0S | 26.00 |
| 07152026 | 14 | 14L/0S | 40.75 |
| 07162026 | 14 | 12L/2S | 91.25 |
| 07172026 | 14 | 3L/11S | 66.75 |

### Pipeline errors

None.

## placement-trader @ sonnet [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -25 | -125.00 |
| 2 | 11 | -17 | -85.00 |
| 3 | 11 | -10.5 | -52.50 |
| 4 | 11 | -18.5 | -92.50 |
| 5 | 11 | -3.75 | -18.75 |
| 6 | 11 | -20 | -100.00 |
| 7 | 11 | -8.75 | -43.75 |
| 8 | 11 | -20.75 | -103.75 |
| 9 | 11 | 8.75 | 43.75 |
| 10 | 11 | 8.5 | 42.50 |
| 11 | 11 | -5.75 | -28.75 |
| 12 | 11 | -21.75 | -108.75 |
| 13 | 11 | -29.5 | -147.50 |
| 14 | 11 | -25.25 | -126.25 |

Wins: 15 · Losses: 76 · Avg win: 43.25 pts · Avg loss: -11.03 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 14 | 14L/0S | 0.50 |
| 07022026 | 14 | 10L/4S | 123.50 |
| 07062026 | 14 | 14L/0S | 52.25 |
| 07072026 | 14 | 14L/0S | 32.00 |
| 07082026 | 14 | 14L/0S | 38.75 |
| 07092026 | 14 | 14L/0S | 0.75 |
| 07132026 | 14 | 12L/2S | 86.50 |
| 07142026 | 14 | 14L/0S | 1.00 |
| 07152026 | 14 | 14L/0S | 0.50 |
| 07162026 | 14 | 3L/11S | 67.00 |
| 07172026 | 14 | 6L/8S | 45.50 |

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
| placement-trader | sonnet | base | 154 | 11 | 14 | ok |
| placement-trader | sonnet | seven-keys-method | 154 | 11 | 14 | ok |
| placement-trader | sonnet | seven-keys-scorecard | 154 | 11 | 14 | ok |
