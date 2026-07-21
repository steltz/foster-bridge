# Trader Scoreboard

66 cells · 6 trader@model@variant groups. Every group is scored alone; P&L is never combined across traders, models, or variants.

## Ranking (mean net USD per run)

| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | context-trader | sonnet | seven-keys-method | 11 | 1 | -6.25 | 0.00 | -6.25 | -6.25 | 20% | 45% |
| 2 | placement-trader | sonnet | seven-keys-method | 11 | 1 | -18.75 | 0.00 | -18.75 | -18.75 | 17% | 55% |
| 3 | context-trader | sonnet | base | 11 | 1 | -97.50 | 0.00 | -97.50 | -97.50 | 17% | 55% |
| 4 | context-trader | sonnet | seven-keys-scorecard | 11 | 1 | -123.75 | 0.00 | -123.75 | -123.75 | 0% | 18% |
| 5 | placement-trader | sonnet | base | 11 | 1 | -125.00 | 0.00 | -125.00 | -125.00 | 17% | 55% |
| 6 | placement-trader | sonnet | seven-keys-scorecard | 11 | 1 | -293.75 | 0.00 | -293.75 | -293.75 | 11% | 82% |

## Feature Impact

Each row compares base and feature over their shared day set only (the Days column); days covered by one side never bias Δ. Runs is base-vs-feature run counts over those days — a lopsided pair is a weakly sampled verdict. Pairs where either side has no filled trades over the shared days are omitted rather than scored zero. For combos, additional tables compare the combo against each of its components over the same shared-day rule.

### Seven-Keys methodology

| Trader | Model | Days | Runs | Base $/run | Seven-Keys methodology $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | sonnet | 11 | 1v1 | -97.50 | -6.25 | +91.25 |
| placement-trader | sonnet | 11 | 1v1 | -125.00 | -18.75 | +106.25 |

**Overall Δ for Seven-Keys methodology across 2 trader/model pairs: +98.75**
### Seven-Keys precomputed scorecard

| Trader | Model | Days | Runs | Base $/run | Seven-Keys precomputed scorecard $/run | Δ |
|---|---|---|---|---|---|---|
| context-trader | sonnet | 11 | 1v1 | -97.50 | -123.75 | -26.25 |
| placement-trader | sonnet | 11 | 1v1 | -125.00 | -293.75 | -168.75 |

**Overall Δ for Seven-Keys precomputed scorecard across 2 trader/model pairs: -97.50**

## Lineage

```
context-trader                 sonnet/base 1r: -97.50 · sonnet/seven-keys-method 1r: -6.25 · sonnet/seven-keys-scorecard 1r: -123.75
placement-trader               sonnet/base 1r: -125.00 · sonnet/seven-keys-method 1r: -18.75 · sonnet/seven-keys-scorecard 1r: -293.75
```

## context-trader @ sonnet [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -1.25 | -6.25 |

Wins: 1 · Losses: 4 · Avg win: 44.50 pts · Avg loss: -11.44 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 1 | 1L/0S | 0.00 |
| 07022026 | 1 | 1L/0S | 0.00 |
| 07062026 | 1 | 1L/0S | 0.00 |
| 07072026 | 1 | 1L/0S | 0.00 |
| 07082026 | 1 | 1L/0S | 0.00 |
| 07092026 | 1 | 1L/0S | 0.00 |
| 07132026 | 1 | 1L/0S | 0.00 |
| 07142026 | 1 | 1L/0S | 0.00 |
| 07152026 | 1 | 1L/0S | 0.00 |
| 07162026 | 1 | 0L/1S | 0.00 |
| 07172026 | 1 | 1L/0S | 0.00 |

### Pipeline errors

None.

## placement-trader @ sonnet [seven-keys-method]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -3.75 | -18.75 |

Wins: 1 · Losses: 5 · Avg win: 44.25 pts · Avg loss: -9.60 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 1 | 1L/0S | 0.00 |
| 07022026 | 1 | 1L/0S | 0.00 |
| 07062026 | 1 | 1L/0S | 0.00 |
| 07072026 | 1 | 1L/0S | 0.00 |
| 07082026 | 1 | 1L/0S | 0.00 |
| 07092026 | 1 | 1L/0S | 0.00 |
| 07132026 | 1 | 1L/0S | 0.00 |
| 07142026 | 1 | 1L/0S | 0.00 |
| 07152026 | 1 | 1L/0S | 0.00 |
| 07162026 | 1 | 1L/0S | 0.00 |
| 07172026 | 1 | 1L/0S | 0.00 |

### Pipeline errors

None.

## context-trader @ sonnet [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -19.5 | -97.50 |

Wins: 1 · Losses: 5 · Avg win: 28.75 pts · Avg loss: -9.65 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 1 | 1L/0S | 0.00 |
| 07022026 | 1 | 1L/0S | 0.00 |
| 07062026 | 1 | 1L/0S | 0.00 |
| 07072026 | 1 | 1L/0S | 0.00 |
| 07082026 | 1 | 1L/0S | 0.00 |
| 07092026 | 1 | 1L/0S | 0.00 |
| 07132026 | 1 | 1L/0S | 0.00 |
| 07142026 | 1 | 1L/0S | 0.00 |
| 07152026 | 1 | 1L/0S | 0.00 |
| 07162026 | 1 | 1L/0S | 0.00 |
| 07172026 | 1 | 1L/0S | 0.00 |

### Pipeline errors

None.

## context-trader @ sonnet [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -24.75 | -123.75 |

Wins: 0 · Losses: 2 · Avg win: - pts · Avg loss: -12.38 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 1 | 1L/0S | 0.00 |
| 07022026 | 1 | 1L/0S | 0.00 |
| 07062026 | 1 | 1L/0S | 0.00 |
| 07072026 | 1 | 1L/0S | 0.00 |
| 07082026 | 1 | 1L/0S | 0.00 |
| 07092026 | 1 | 1L/0S | 0.00 |
| 07132026 | 1 | 1L/0S | 0.00 |
| 07142026 | 1 | 0L/1S | 0.00 |
| 07152026 | 1 | 1L/0S | 0.00 |
| 07162026 | 1 | 1L/0S | 0.00 |
| 07172026 | 1 | 1L/0S | 0.00 |

### Pipeline errors

None.

## placement-trader @ sonnet [base]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -25 | -125.00 |

Wins: 1 · Losses: 5 · Avg win: 44.25 pts · Avg loss: -13.85 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 1 | 1L/0S | 0.00 |
| 07022026 | 1 | 1L/0S | 0.00 |
| 07062026 | 1 | 1L/0S | 0.00 |
| 07072026 | 1 | 1L/0S | 0.00 |
| 07082026 | 1 | 1L/0S | 0.00 |
| 07092026 | 1 | 1L/0S | 0.00 |
| 07132026 | 1 | 1L/0S | 0.00 |
| 07142026 | 1 | 1L/0S | 0.00 |
| 07152026 | 1 | 1L/0S | 0.00 |
| 07162026 | 1 | 1L/0S | 0.00 |
| 07172026 | 1 | 0L/1S | 0.00 |

### Pipeline errors

None.

## placement-trader @ sonnet [seven-keys-scorecard]

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 11 | -58.75 | -293.75 |

Wins: 1 · Losses: 8 · Avg win: 36.50 pts · Avg loss: -11.91 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 1 | 1L/0S | 0.00 |
| 07022026 | 1 | 1L/0S | 0.00 |
| 07062026 | 1 | 1L/0S | 0.00 |
| 07072026 | 1 | 1L/0S | 0.00 |
| 07082026 | 1 | 1L/0S | 0.00 |
| 07092026 | 1 | 1L/0S | 0.00 |
| 07132026 | 1 | 1L/0S | 0.00 |
| 07142026 | 1 | 1L/0S | 0.00 |
| 07152026 | 1 | 1L/0S | 0.00 |
| 07162026 | 1 | 1L/0S | 0.00 |
| 07172026 | 1 | 0L/1S | 0.00 |

### Pipeline errors

None.

## Coverage

| Trader | Model | Variant | Cells | Days | Runs | Status |
|---|---|---|---|---|---|---|
| context-trader | sonnet | base | 11 | 11 | 1 | ok |
| context-trader | sonnet | seven-keys-method | 11 | 11 | 1 | ok |
| context-trader | sonnet | seven-keys-scorecard | 11 | 11 | 1 | ok |
| placement-trader | sonnet | base | 11 | 11 | 1 | ok |
| placement-trader | sonnet | seven-keys-method | 11 | 11 | 1 | ok |
| placement-trader | sonnet | seven-keys-scorecard | 11 | 11 | 1 | ok |
