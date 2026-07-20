# Trader Scoreboard

630 cells · 12 trader@model@variant groups. Every group is scored alone; P&L is never combined across traders, models, or variants.

## Ranking (mean net USD per run)

| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | placement-trader | fable | seven-keys-method | 11 | 5 | 58.00 | 96.99 | -45.00 | 185.00 | 25% | 58% |
| 2 | context-trader | sonnet | seven-keys-scorecard | 10 | 5 | 22.50 | 60.03 | -68.75 | 81.25 | 29% | 34% |
| 3 | context-trader | fable | base | 11 | 5 | 18.25 | 100.65 | -153.75 | 108.75 | 27% | 40% |
| 4 | context-trader | fable | seven-keys-method | 11 | 5 | 13.75 | 68.63 | -97.50 | 71.25 | 22% | 33% |
| 5 | context-trader | sonnet | seven-keys-method | 10 | 5 | -7.50 | 136.89 | -233.75 | 116.25 | 18% | 44% |
| 6 | placement-trader | sonnet | seven-keys-scorecard | 10 | 5 | -15.25 | 38.32 | -67.50 | 35.00 | 17% | 60% |
| 7 | placement-trader | fable | base | 11 | 5 | -41.25 | 53.51 | -118.75 | 6.25 | 19% | 49% |
| 8 | placement-trader | sonnet | seven-keys-method | 10 | 5 | -66.00 | 65.36 | -125.00 | 37.50 | 16% | 62% |
| 9 | placement-trader | fable | seven-keys-scorecard | 11 | 5 | -76.50 | 83.23 | -146.25 | 55.00 | 17% | 64% |
| 10 | placement-trader | sonnet | base | 10 | 5 | -81.75 | 28.44 | -127.50 | -52.50 | 17% | 60% |
| 11 | context-trader | fable | seven-keys-scorecard | 11 | 5 | -84.00 | 75.57 | -178.75 | -6.25 | 14% | 25% |
| 12 | context-trader | sonnet | base | 10 | 5 | -99.75 | 105.05 | -222.50 | 35.00 | 19% | 54% |

## Feature Impact

Each row compares base and feature over their shared day set only (the Days column); days covered by one side never bias Δ. Runs is base-vs-feature run counts over those days — a lopsided pair is a weakly sampled verdict. Pairs where either side has no filled trades over the shared days are omitted rather than scored zero. For combos, additional tables compare the combo against each of its components over the same shared-day rule.

### Seven-Keys methodology

| Trader | Model | Days | Runs | Base $/run | Seven-Keys methodology $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | fable | 11 | 5v5 | 18.25 | 13.75 | -4.50 |
| context-trader | sonnet | 10 | 5v5 | -99.75 | -7.50 | +92.25 |
| placement-trader | fable | 11 | 5v5 | -41.25 | 58.00 | +99.25 |
| placement-trader | sonnet | 10 | 5v5 | -81.75 | -66.00 | +15.75 |

**Overall Δ for Seven-Keys methodology across 4 trader/model pairs: +50.69**
### Seven-Keys precomputed scorecard

| Trader | Model | Days | Runs | Base $/run | Seven-Keys precomputed scorecard $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | fable | 11 | 5v5 | 18.25 | -84.00 | -102.25 |
| context-trader | sonnet | 10 | 5v5 | -99.75 | 22.50 | +122.25 |
| placement-trader | fable | 11 | 5v5 | -41.25 | -76.50 | -35.25 |
| placement-trader | sonnet | 10 | 5v5 | -81.75 | -15.25 | +66.50 |

**Overall Δ for Seven-Keys precomputed scorecard across 4 trader/model pairs: +12.81**

## Lineage

```
context-trader                 fable/base 5r: 18.25 · fable/seven-keys-method 5r: 13.75 · fable/seven-keys-scorecard 5r: -84.00 · sonnet/base 5r: -99.75 · sonnet/seven-keys-method 5r: -7.50 · sonnet/seven-keys-scorecard 5r: 22.50
placement-trader               fable/base 5r: -41.25 · fable/seven-keys-method 5r: 58.00 · fable/seven-keys-scorecard 5r: -76.50 · sonnet/base 5r: -81.75 · sonnet/seven-keys-method 5r: -66.00 · sonnet/seven-keys-scorecard 5r: -15.25
```

## placement-trader @ fable [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -9 | -45.00 |
| 2 | 11 | 26.75 | 133.75 |
| 3 | 11 | -0.25 | -1.25 |
| 4 | 11 | 37 | 185.00 |
| 5 | 11 | 3.5 | 17.50 |

Wins: 8 · Losses: 24 · Avg win: 37.25 pts · Avg loss: -10.00 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 3.25 |
| 07022026 | 5 | 5L/0S | 46.75 |
| 07062026 | 5 | 5L/0S | 50.00 |
| 07072026 | 5 | 5L/0S | 26.00 |
| 07082026 | 5 | 5L/0S | 3.25 |
| 07092026 | 5 | 5L/0S | 3.50 |
| 07132026 | 5 | 5L/0S | 5.00 |
| 07142026 | 5 | 5L/0S | 0.50 |
| 07152026 | 5 | 5L/0S | 37.75 |
| 07162026 | 5 | 5L/0S | 46.00 |
| 07172026 | 5 | 3L/2S | 45.75 |

### Pipeline errors

None.

## context-trader @ sonnet [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 7 | 35.00 |
| 2 | 10 | 13.25 | 66.25 |
| 3 | 10 | -0.25 | -1.25 |
| 4 | 10 | -13.75 | -68.75 |
| 5 | 10 | 16.25 | 81.25 |

Wins: 5 · Losses: 12 · Avg win: 28.85 pts · Avg loss: -10.15 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 26.75 |
| 07022026 | 5 | 5L/0S | 7.50 |
| 07062026 | 5 | 5L/0S | 6.50 |
| 07072026 | 5 | 5L/0S | 83.50 |
| 07082026 | 5 | 5L/0S | 78.00 |
| 07092026 | 5 | 5L/0S | 0.25 |
| 07132026 | 5 | 3L/2S | 118.00 |
| 07142026 | 5 | 3L/2S | 60.25 |
| 07152026 | 5 | 5L/0S | 3.00 |
| 07162026 | 5 | 5L/0S | 52.75 |

### Pipeline errors

None.

## context-trader @ fable [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | 21.75 | 108.75 |
| 2 | 11 | -30.75 | -153.75 |
| 3 | 11 | 6.5 | 32.50 |
| 4 | 11 | 8 | 40.00 |
| 5 | 11 | 12.75 | 63.75 |

Wins: 6 · Losses: 16 · Avg win: 22.96 pts · Avg loss: -7.47 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 31.00 |
| 07022026 | 5 | 3L/2S | 132.00 |
| 07062026 | 5 | 5L/0S | 2.25 |
| 07072026 | 5 | 5L/0S | 6.75 |
| 07082026 | 5 | 5L/0S | 82.75 |
| 07092026 | 5 | 5L/0S | 3.25 |
| 07132026 | 5 | 5L/0S | 38.75 |
| 07142026 | 5 | 5L/0S | 2.00 |
| 07152026 | 5 | 5L/0S | 36.75 |
| 07162026 | 5 | 5L/0S | 23.00 |
| 07172026 | 5 | 5L/0S | 6.50 |

### Pipeline errors

None.

## context-trader @ fable [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | 14.25 | 71.25 |
| 2 | 11 | 11 | 55.00 |
| 3 | 11 | -1.25 | -6.25 |
| 4 | 11 | 9.25 | 46.25 |
| 5 | 11 | -19.5 | -97.50 |

Wins: 4 · Losses: 14 · Avg win: 28.31 pts · Avg loss: -7.11 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 31.00 |
| 07022026 | 5 | 3L/2S | 131.00 |
| 07062026 | 5 | 5L/0S | 1.00 |
| 07072026 | 5 | 5L/0S | 5.50 |
| 07082026 | 5 | 5L/0S | 86.75 |
| 07092026 | 5 | 5L/0S | 6.50 |
| 07132026 | 5 | 5L/0S | 38.00 |
| 07142026 | 5 | 5L/0S | 27.00 |
| 07152026 | 5 | 5L/0S | 3.75 |
| 07162026 | 5 | 5L/0S | 2.50 |
| 07172026 | 5 | 5L/0S | 6.75 |

### Pipeline errors

None.

## context-trader @ sonnet [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | -5.75 | -28.75 |
| 2 | 10 | -46.75 | -233.75 |
| 3 | 10 | 8.25 | 41.25 |
| 4 | 10 | 23.25 | 116.25 |
| 5 | 10 | 13.5 | 67.50 |

Wins: 4 · Losses: 18 · Avg win: 43.19 pts · Avg loss: -10.01 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 7.50 |
| 07022026 | 5 | 5L/0S | 4.75 |
| 07062026 | 5 | 5L/0S | 6.25 |
| 07072026 | 5 | 5L/0S | 25.75 |
| 07082026 | 5 | 5L/0S | 91.50 |
| 07092026 | 5 | 5L/0S | 7.50 |
| 07132026 | 5 | 4L/1S | 100.25 |
| 07142026 | 5 | 5L/0S | 32.50 |
| 07152026 | 5 | 5L/0S | 36.75 |
| 07162026 | 5 | 4L/1S | 71.00 |

### Pipeline errors

None.

## placement-trader @ sonnet [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 0.75 | 3.75 |
| 2 | 10 | -6.25 | -31.25 |
| 3 | 10 | 7 | 35.00 |
| 4 | 10 | -13.5 | -67.50 |
| 5 | 10 | -3.25 | -16.25 |

Wins: 5 · Losses: 25 · Avg win: 40.95 pts · Avg loss: -8.80 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 25.25 |
| 07022026 | 5 | 5L/0S | 62.75 |
| 07062026 | 5 | 5L/0S | 22.25 |
| 07072026 | 5 | 5L/0S | 3.00 |
| 07082026 | 5 | 3L/2S | 55.00 |
| 07092026 | 5 | 5L/0S | 1.50 |
| 07132026 | 5 | 2L/3S | 78.00 |
| 07142026 | 5 | 3L/2S | 34.00 |
| 07152026 | 5 | 5L/0S | 36.75 |
| 07162026 | 5 | 5L/0S | 1.75 |

### Pipeline errors

None.

## placement-trader @ fable [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -2.5 | -12.50 |
| 2 | 11 | 1.25 | 6.25 |
| 3 | 11 | -23.75 | -118.75 |
| 4 | 11 | -15 | -75.00 |
| 5 | 11 | -1.25 | -6.25 |

Wins: 5 · Losses: 22 · Avg win: 36.70 pts · Avg loss: -10.22 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 23.50 |
| 07022026 | 5 | 5L/0S | 64.50 |
| 07062026 | 5 | 5L/0S | 28.00 |
| 07072026 | 5 | 5L/0S | 24.00 |
| 07082026 | 5 | 5L/0S | 92.25 |
| 07092026 | 5 | 5L/0S | 0.75 |
| 07132026 | 5 | 5L/0S | 5.75 |
| 07142026 | 5 | 5L/0S | 2.00 |
| 07152026 | 5 | 5L/0S | 40.50 |
| 07162026 | 5 | 5L/0S | 22.50 |
| 07172026 | 5 | 3L/2S | 46.00 |

### Pipeline errors

None.

## placement-trader @ sonnet [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | -20.75 | -103.75 |
| 2 | 10 | -25 | -125.00 |
| 3 | 10 | -8.5 | -42.50 |
| 4 | 10 | 7.5 | 37.50 |
| 5 | 10 | -19.25 | -96.25 |

Wins: 5 · Losses: 26 · Avg win: 44.85 pts · Avg loss: -11.16 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 19.75 |
| 07022026 | 5 | 5L/0S | 61.75 |
| 07062026 | 5 | 5L/0S | 26.00 |
| 07072026 | 5 | 5L/0S | 30.25 |
| 07082026 | 5 | 5L/0S | 0.75 |
| 07092026 | 5 | 5L/0S | 0.25 |
| 07132026 | 5 | 5L/0S | 16.00 |
| 07142026 | 5 | 5L/0S | 8.75 |
| 07152026 | 5 | 5L/0S | 7.75 |
| 07162026 | 5 | 5L/0S | 45.75 |

### Pipeline errors

None.

## placement-trader @ fable [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -10.25 | -51.25 |
| 2 | 11 | -28.75 | -143.75 |
| 3 | 11 | -29.25 | -146.25 |
| 4 | 11 | 11 | 55.00 |
| 5 | 11 | -19.25 | -96.25 |

Wins: 6 · Losses: 29 · Avg win: 32.00 pts · Avg loss: -9.26 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 0.50 |
| 07022026 | 5 | 5L/0S | 2.50 |
| 07062026 | 5 | 5L/0S | 29.25 |
| 07072026 | 5 | 5L/0S | 21.00 |
| 07082026 | 5 | 5L/0S | 6.00 |
| 07092026 | 5 | 5L/0S | 3.00 |
| 07132026 | 5 | 5L/0S | 2.00 |
| 07142026 | 5 | 5L/0S | 1.50 |
| 07152026 | 5 | 5L/0S | 19.00 |
| 07162026 | 5 | 4L/1S | 45.50 |
| 07172026 | 5 | 0L/5S | 5.00 |

### Pipeline errors

None.

## placement-trader @ sonnet [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | -25.5 | -127.50 |
| 2 | 10 | -14.5 | -72.50 |
| 3 | 10 | -10.5 | -52.50 |
| 4 | 10 | -13.75 | -68.75 |
| 5 | 10 | -17.5 | -87.50 |

Wins: 5 · Losses: 25 · Avg win: 44.40 pts · Avg loss: -12.15 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 0.00 |
| 07022026 | 5 | 5L/0S | 62.75 |
| 07062026 | 5 | 5L/0S | 53.75 |
| 07072026 | 5 | 5L/0S | 26.50 |
| 07082026 | 5 | 5L/0S | 0.75 |
| 07092026 | 5 | 5L/0S | 0.25 |
| 07132026 | 5 | 4L/1S | 76.00 |
| 07142026 | 5 | 5L/0S | 0.25 |
| 07152026 | 5 | 5L/0S | 1.50 |
| 07162026 | 5 | 5L/0S | 45.50 |

### Pipeline errors

None.

## context-trader @ fable [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -20.75 | -103.75 |
| 2 | 11 | -24.75 | -123.75 |
| 3 | 11 | -1.5 | -7.50 |
| 4 | 11 | -35.75 | -178.75 |
| 5 | 11 | -1.25 | -6.25 |

Wins: 2 · Losses: 12 · Avg win: 13.50 pts · Avg loss: -9.25 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 4.00 |
| 07022026 | 5 | 5L/0S | 7.75 |
| 07062026 | 5 | 5L/0S | 3.00 |
| 07072026 | 5 | 5L/0S | 76.00 |
| 07082026 | 5 | 5L/0S | 17.00 |
| 07092026 | 5 | 5L/0S | 24.00 |
| 07132026 | 5 | 5L/0S | 9.00 |
| 07142026 | 5 | 4L/1S | 107.00 |
| 07152026 | 5 | 5L/0S | 3.25 |
| 07162026 | 5 | 5L/0S | 46.50 |
| 07172026 | 5 | 0L/5S | 0.25 |

### Pipeline errors

None.

## context-trader @ sonnet [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | -44.5 | -222.50 |
| 2 | 10 | -37.5 | -187.50 |
| 3 | 10 | -9.75 | -48.75 |
| 4 | 10 | 7 | 35.00 |
| 5 | 10 | -15 | -75.00 |

Wins: 5 · Losses: 22 · Avg win: 23.25 pts · Avg loss: -9.82 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 7.50 |
| 07022026 | 5 | 5L/0S | 65.75 |
| 07062026 | 5 | 4L/1S | 112.25 |
| 07072026 | 5 | 5L/0S | 27.00 |
| 07082026 | 5 | 5L/0S | 91.75 |
| 07092026 | 5 | 5L/0S | 4.50 |
| 07132026 | 5 | 4L/1S | 104.25 |
| 07142026 | 5 | 5L/0S | 4.50 |
| 07152026 | 5 | 5L/0S | 41.00 |
| 07162026 | 5 | 4L/1S | 70.50 |

### Pipeline errors

None.

## Coverage

| Trader | Model | Variant | Cells | Days | Runs | Status |
|---|---|---|---|---|---|---|
| context-trader | fable | base | 55 | 11 | 5 | ok |
| context-trader | fable | seven-keys-method | 55 | 11 | 5 | ok |
| context-trader | fable | seven-keys-scorecard | 55 | 11 | 5 | ok |
| context-trader | sonnet | base | 50 | 10 | 5 | ⚠ under-tested (max 55) |
| context-trader | sonnet | seven-keys-method | 50 | 10 | 5 | ⚠ under-tested (max 55) |
| context-trader | sonnet | seven-keys-scorecard | 50 | 10 | 5 | ⚠ under-tested (max 55) |
| placement-trader | fable | base | 55 | 11 | 5 | ok |
| placement-trader | fable | seven-keys-method | 55 | 11 | 5 | ok |
| placement-trader | fable | seven-keys-scorecard | 55 | 11 | 5 | ok |
| placement-trader | sonnet | base | 50 | 10 | 5 | ⚠ under-tested (max 55) |
| placement-trader | sonnet | seven-keys-method | 50 | 10 | 5 | ⚠ under-tested (max 55) |
| placement-trader | sonnet | seven-keys-scorecard | 50 | 10 | 5 | ⚠ under-tested (max 55) |
