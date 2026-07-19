# Trader Scoreboard

740 cells · 10 trader@model groups. Every group is scored alone; P&L is never combined across traders or models.

## Ranking (mean net USD per run)

Keys: Nk/M = N of the group's M cells ran with the shared Seven-Keys artifact; the rest predate it.

| # | Trader | Model | Days | Runs | Keys | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | placement-trader | fable | 10 | 6 | 10k/60 | 169.58 | 40.11 | 136.25 | 243.75 | 33% | 60% |
| 2 | context-trader | fable | 10 | 6 | 10k/60 | 94.17 | 74.44 | -11.25 | 170.00 | 32% | 47% |
| 3 | rotation-trader | sonnet | 10 | 10 | 100k/100 | 0.00 | 0.00 | 0.00 | 0.00 | - | 0% |
| 4 | rotation-trader | fable | 10 | 6 | 10k/60 | -3.33 | 8.16 | -20.00 | 0.00 | 0% | 2% |
| 5 | basehit-trader | fable | 10 | 6 | 10k/60 | -9.58 | 32.94 | -33.75 | 53.75 | 42% | 43% |
| 6 | context-trader | sonnet | 10 | 10 | 50k/100 | -10.63 | 79.48 | -133.75 | 120.00 | 24% | 45% |
| 7 | placement-trader | sonnet | 10 | 10 | 50k/100 | -24.88 | 98.97 | -111.25 | 208.75 | 20% | 60% |
| 8 | basehit-trader | sonnet | 10 | 10 | 100k/100 | -31.25 | 44.25 | -85.00 | 48.75 | 37% | 27% |
| 9 | placement-trader | opus | 10 | 5 | 0k/50 | -44.50 | 106.27 | -158.75 | 121.25 | 22% | 46% |
| 10 | context-trader | opus | 10 | 5 | 0k/50 | -83.00 | 102.40 | -196.25 | 15.00 | 15% | 40% |

## Lineage

```
basehit-trader                 fable 6r: -9.58 · sonnet 10r: -31.25
context-trader                 fable 6r: 94.17 · opus 5r: -83.00 · sonnet 10r: -10.63
placement-trader               fable 6r: 169.58 · opus 5r: -44.50 · sonnet 10r: -24.88
rotation-trader                fable 6r: -3.33 · sonnet 10r: 0.00
```

## placement-trader @ fable

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 33.5 | 167.50 |
| 2 | 10 | 36 | 180.00 |
| 3 | 10 | 48.75 | 243.75 |
| 4 | 10 | 27.25 | 136.25 |
| 5 | 10 | 27.5 | 137.50 |
| 6 | 10 | 30.5 | 152.50 |

Wins: 12 · Losses: 24 · Avg win: 32.13 pts · Avg loss: -7.58 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 6 | 6L/0S | 5.25 |
| 07022026 | 6 | 6L/0S | 0.75 |
| 07062026 | 6 | 6L/0S | 29.00 |
| 07072026 | 6 | 6L/0S | 26.50 |
| 07082026 | 6 | 6L/0S | 6.00 |
| 07092026 | 6 | 6L/0S | 3.50 |
| 07132026 | 6 | 5L/1S | 61.75 |
| 07142026 | 6 | 6L/0S | 0.50 |
| 07152026 | 6 | 6L/0S | 0.75 |
| 07162026 | 6 | 6L/0S | 45.25 |

### Pipeline errors

None.

## context-trader @ fable

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 9.75 | 48.75 |
| 2 | 10 | 27.25 | 136.25 |
| 3 | 10 | 34 | 170.00 |
| 4 | 10 | 10.75 | 53.75 |
| 5 | 10 | -2.25 | -11.25 |
| 6 | 10 | 33.5 | 167.50 |

Wins: 9 · Losses: 19 · Avg win: 28.83 pts · Avg loss: -7.71 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 6 | 6L/0S | 31.00 |
| 07022026 | 6 | 6L/0S | 66.00 |
| 07062026 | 6 | 6L/0S | 4.75 |
| 07072026 | 6 | 6L/0S | 6.00 |
| 07082026 | 6 | 6L/0S | 94.50 |
| 07092026 | 6 | 6L/0S | 3.50 |
| 07132026 | 6 | 5L/1S | 88.50 |
| 07142026 | 6 | 6L/0S | 24.75 |
| 07152026 | 6 | 6L/0S | 17.50 |
| 07162026 | 6 | 6L/0S | 47.00 |

### Pipeline errors

None.

## rotation-trader @ sonnet

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 0 | 0.00 |
| 2 | 10 | 0 | 0.00 |
| 3 | 10 | 0 | 0.00 |
| 4 | 10 | 0 | 0.00 |
| 5 | 10 | 0 | 0.00 |
| 6 | 10 | 0 | 0.00 |
| 7 | 10 | 0 | 0.00 |
| 8 | 10 | 0 | 0.00 |
| 9 | 10 | 0 | 0.00 |
| 10 | 10 | 0 | 0.00 |

Wins: 0 · Losses: 0 · Avg win: - pts · Avg loss: - pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 10 | 10L/0S | 1.25 |
| 07022026 | 10 | 0L/10S | 1.50 |
| 07062026 | 10 | 9L/1S | 121.50 |
| 07072026 | 10 | 8L/2S | 197.50 |
| 07082026 | 10 | 10L/0S | 18.75 |
| 07092026 | 10 | 10L/0S | 32.25 |
| 07132026 | 10 | 8L/2S | 165.25 |
| 07142026 | 10 | 0L/10S | 1.00 |
| 07152026 | 10 | 6L/4S | 141.50 |
| 07162026 | 10 | 8L/2S | 111.00 |

### Pipeline errors

None.

## rotation-trader @ fable

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 0 | 0.00 |
| 2 | 10 | 0 | 0.00 |
| 3 | 10 | 0 | 0.00 |
| 4 | 10 | 0 | 0.00 |
| 5 | 10 | 0 | 0.00 |
| 6 | 10 | -4 | -20.00 |

Wins: 0 · Losses: 1 · Avg win: - pts · Avg loss: -4.00 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 6 | 6L/0S | 0.75 |
| 07022026 | 6 | 1L/5S | 135.75 |
| 07062026 | 6 | 6L/0S | 1.50 |
| 07072026 | 6 | 6L/0S | 0.00 |
| 07082026 | 6 | 6L/0S | 36.25 |
| 07092026 | 6 | 6L/0S | 31.00 |
| 07132026 | 6 | 3L/3S | 112.75 |
| 07142026 | 6 | 0L/6S | 0.25 |
| 07152026 | 6 | 5L/1S | 165.25 |
| 07162026 | 6 | 5L/1S | 109.25 |

### Pipeline errors

None.

## basehit-trader @ fable

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | -6.75 | -33.75 |
| 2 | 10 | -5.5 | -27.50 |
| 3 | 10 | 10.75 | 53.75 |
| 4 | 10 | -4.75 | -23.75 |
| 5 | 10 | -5 | -25.00 |
| 6 | 10 | -0.25 | -1.25 |

Wins: 11 · Losses: 15 · Avg win: 13.18 pts · Avg loss: -10.43 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 6 | 6L/0S | 27.00 |
| 07022026 | 6 | 4L/2S | 125.25 |
| 07062026 | 6 | 6L/0S | 2.75 |
| 07072026 | 6 | 6L/0S | 26.25 |
| 07082026 | 6 | 6L/0S | 0.25 |
| 07092026 | 6 | 6L/0S | 0.25 |
| 07132026 | 6 | 3L/3S | 60.00 |
| 07142026 | 6 | 5L/1S | 55.25 |
| 07152026 | 6 | 6L/0S | 21.75 |
| 07162026 | 6 | 6L/0S | 48.00 |

### Pipeline errors

None.

## context-trader @ sonnet

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 24 | 120.00 |
| 2 | 10 | -26.75 | -133.75 |
| 3 | 10 | -8.75 | -43.75 |
| 4 | 10 | -21.5 | -107.50 |
| 5 | 10 | -0.25 | -1.25 |
| 6 | 10 | 20.25 | 101.25 |
| 7 | 10 | -1.75 | -8.75 |
| 8 | 10 | 3.75 | 18.75 |
| 9 | 10 | -7.25 | -36.25 |
| 10 | 10 | -3 | -15.00 |

Wins: 11 · Losses: 34 · Avg win: 28.89 pts · Avg loss: -9.97 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 10 | 10L/0S | 28.00 |
| 07022026 | 10 | 10L/0S | 67.50 |
| 07062026 | 10 | 10L/0S | 4.00 |
| 07072026 | 10 | 10L/0S | 90.25 |
| 07082026 | 10 | 9L/1S | 190.00 |
| 07092026 | 10 | 10L/0S | 4.75 |
| 07132026 | 10 | 9L/1S | 121.25 |
| 07142026 | 10 | 9L/1S | 61.50 |
| 07152026 | 10 | 10L/0S | 42.75 |
| 07162026 | 10 | 9L/1S | 72.25 |

### Pipeline errors

None.

## placement-trader @ sonnet

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | -16.75 | -83.75 |
| 2 | 10 | 15.25 | 76.25 |
| 3 | 10 | -4.25 | -21.25 |
| 4 | 10 | -1 | -5.00 |
| 5 | 10 | -22.25 | -111.25 |
| 6 | 10 | -19.5 | -97.50 |
| 7 | 10 | -15.5 | -77.50 |
| 8 | 10 | -12.25 | -61.25 |
| 9 | 10 | -15.25 | -76.25 |
| 10 | 10 | 41.75 | 208.75 |

Wins: 12 · Losses: 48 · Avg win: 38.46 pts · Avg loss: -10.65 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 10 | 10L/0S | 25.00 |
| 07022026 | 10 | 10L/0S | 63.00 |
| 07062026 | 10 | 10L/0S | 0.75 |
| 07072026 | 10 | 10L/0S | 27.75 |
| 07082026 | 10 | 10L/0S | 11.00 |
| 07092026 | 10 | 10L/0S | 2.25 |
| 07132026 | 10 | 8L/2S | 107.00 |
| 07142026 | 10 | 8L/2S | 55.50 |
| 07152026 | 10 | 10L/0S | 41.50 |
| 07162026 | 10 | 8L/2S | 65.50 |

### Pipeline errors

None.

## basehit-trader @ sonnet

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 9.75 | 48.75 |
| 2 | 10 | -11.5 | -57.50 |
| 3 | 10 | -10.75 | -53.75 |
| 4 | 10 | -11.25 | -56.25 |
| 5 | 10 | 7 | 35.00 |
| 6 | 10 | -10.5 | -52.50 |
| 7 | 10 | -6.75 | -33.75 |
| 8 | 10 | 0 | 0.00 |
| 9 | 10 | -11.5 | -57.50 |
| 10 | 10 | -17 | -85.00 |

Wins: 10 · Losses: 17 · Avg win: 16.43 pts · Avg loss: -13.34 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 10 | 10L/0S | 27.00 |
| 07022026 | 10 | 10L/0S | 5.75 |
| 07062026 | 10 | 10L/0S | 2.75 |
| 07072026 | 10 | 10L/0S | 13.25 |
| 07082026 | 10 | 7L/3S | 96.25 |
| 07092026 | 10 | 10L/0S | 4.50 |
| 07132026 | 10 | 4L/6S | 115.75 |
| 07142026 | 10 | 10L/0S | 54.00 |
| 07152026 | 10 | 10L/0S | 55.00 |
| 07162026 | 10 | 10L/0S | 5.00 |

### Pipeline errors

None.

## placement-trader @ opus

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 24.25 | 121.25 |
| 2 | 10 | -21.5 | -107.50 |
| 3 | 10 | -11.25 | -56.25 |
| 4 | 10 | -4.25 | -21.25 |
| 5 | 10 | -31.75 | -158.75 |

Wins: 5 · Losses: 18 · Avg win: 32.25 pts · Avg loss: -11.43 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 24.75 |
| 07022026 | 5 | 5L/0S | 62.75 |
| 07062026 | 5 | 5L/0S | 27.00 |
| 07072026 | 5 | 5L/0S | 27.25 |
| 07082026 | 5 | 5L/0S | 41.50 |
| 07092026 | 5 | 5L/0S | 5.25 |
| 07132026 | 5 | 5L/0S | 4.00 |
| 07142026 | 5 | 5L/0S | 2.25 |
| 07152026 | 5 | 5L/0S | 18.25 |
| 07162026 | 5 | 5L/0S | 20.75 |

### Pipeline errors

None.

## context-trader @ opus

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | -39.25 | -196.25 |
| 2 | 10 | 0 | 0.00 |
| 3 | 10 | -37.75 | -188.75 |
| 4 | 10 | -9 | -45.00 |
| 5 | 10 | 3 | 15.00 |

Wins: 3 · Losses: 17 · Avg win: 26.67 pts · Avg loss: -9.59 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 28.25 |
| 07022026 | 5 | 5L/0S | 3.75 |
| 07062026 | 5 | 5L/0S | 3.50 |
| 07072026 | 5 | 5L/0S | 85.25 |
| 07082026 | 5 | 5L/0S | 7.00 |
| 07092026 | 5 | 5L/0S | 6.00 |
| 07132026 | 5 | 5L/0S | 23.00 |
| 07142026 | 5 | 5L/0S | 28.50 |
| 07152026 | 5 | 5L/0S | 7.00 |
| 07162026 | 5 | 5L/0S | 27.25 |

### Pipeline errors

None.

## Coverage

| Trader | Model | Cells | Days | Runs | Status |
|---|---|---|---|---|---|
| basehit-trader | fable | 60 | 10 | 6 | ⚠ under-tested (max 100) |
| basehit-trader | sonnet | 100 | 10 | 10 | ok |
| context-trader | fable | 60 | 10 | 6 | ⚠ under-tested (max 100) |
| context-trader | opus | 50 | 10 | 5 | ⚠ under-tested (max 100) |
| context-trader | sonnet | 100 | 10 | 10 | ok |
| placement-trader | fable | 60 | 10 | 6 | ⚠ under-tested (max 100) |
| placement-trader | opus | 50 | 10 | 5 | ⚠ under-tested (max 100) |
| placement-trader | sonnet | 100 | 10 | 10 | ok |
| rotation-trader | fable | 60 | 10 | 6 | ⚠ under-tested (max 100) |
| rotation-trader | sonnet | 100 | 10 | 10 | ok |
