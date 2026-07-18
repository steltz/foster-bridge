# Trader Scoreboard

400 cells · 8 trader@model groups. Every group is scored alone; P&L is never combined across traders or models.

## Ranking (mean net USD per run)

Keys: Nk/M = N of the group's M cells ran with the shared Seven-Keys artifact; the rest predate it.

| # | Trader | Model | Days | Runs | Keys | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | placement-trader | fable | 10 | 5 | 0k/50 | 173.00 | 43.86 | 136.25 | 243.75 | 33% | 60% |
| 2 | context-trader | fable | 10 | 5 | 0k/50 | 79.50 | 72.90 | -11.25 | 170.00 | 28% | 50% |
| 3 | rotation-trader | fable | 10 | 5 | 0k/50 | 0.00 | 0.00 | 0.00 | 0.00 | - | 0% |
| 4 | basehit-trader | fable | 10 | 5 | 0k/50 | -11.25 | 36.54 | -33.75 | 53.75 | 41% | 44% |
| 5 | placement-trader | sonnet | 10 | 5 | 0k/50 | -29.00 | 73.27 | -111.25 | 76.25 | 20% | 60% |
| 6 | context-trader | sonnet | 10 | 5 | 0k/50 | -33.25 | 100.29 | -133.75 | 120.00 | 21% | 56% |
| 7 | placement-trader | opus | 10 | 5 | 0k/50 | -44.50 | 106.27 | -158.75 | 121.25 | 22% | 46% |
| 8 | context-trader | opus | 10 | 5 | 0k/50 | -83.00 | 102.40 | -196.25 | 15.00 | 15% | 40% |

## Lineage

```
basehit-trader                 fable 5r: -11.25
context-trader                 fable 5r: 79.50 · opus 5r: -83.00 · sonnet 5r: -33.25
placement-trader               fable 5r: 173.00 · opus 5r: -44.50 · sonnet 5r: -29.00
rotation-trader                fable 5r: 0.00
```

## placement-trader @ fable

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 33.5 | 167.50 |
| 2 | 10 | 36 | 180.00 |
| 3 | 10 | 48.75 | 243.75 |
| 4 | 10 | 27.25 | 136.25 |
| 5 | 10 | 27.5 | 137.50 |

Wins: 10 · Losses: 20 · Avg win: 32.42 pts · Avg loss: -7.56 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 4.00 |
| 07022026 | 5 | 5L/0S | 0.75 |
| 07062026 | 5 | 5L/0S | 5.00 |
| 07072026 | 5 | 5L/0S | 26.50 |
| 07082026 | 5 | 5L/0S | 6.00 |
| 07092026 | 5 | 5L/0S | 3.50 |
| 07132026 | 5 | 5L/0S | 1.00 |
| 07142026 | 5 | 5L/0S | 0.50 |
| 07152026 | 5 | 5L/0S | 0.75 |
| 07162026 | 5 | 5L/0S | 15.75 |

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

Wins: 7 · Losses: 18 · Avg win: 31.29 pts · Avg loss: -7.75 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 31.00 |
| 07022026 | 5 | 5L/0S | 66.00 |
| 07062026 | 5 | 5L/0S | 4.75 |
| 07072026 | 5 | 5L/0S | 4.50 |
| 07082026 | 5 | 5L/0S | 94.50 |
| 07092026 | 5 | 5L/0S | 3.50 |
| 07132026 | 5 | 5L/0S | 1.00 |
| 07142026 | 5 | 5L/0S | 0.00 |
| 07152026 | 5 | 5L/0S | 0.00 |
| 07162026 | 5 | 5L/0S | 2.75 |

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

Wins: 0 · Losses: 0 · Avg win: - pts · Avg loss: - pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 0.75 |
| 07022026 | 5 | 0L/5S | 0.75 |
| 07062026 | 5 | 5L/0S | 0.00 |
| 07072026 | 5 | 5L/0S | 0.00 |
| 07082026 | 5 | 5L/0S | 0.75 |
| 07092026 | 5 | 5L/0S | 0.50 |
| 07132026 | 5 | 3L/2S | 112.75 |
| 07142026 | 5 | 0L/5S | 0.25 |
| 07152026 | 5 | 4L/1S | 119.25 |
| 07162026 | 5 | 4L/1S | 108.75 |

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

Wins: 9 · Losses: 13 · Avg win: 13.72 pts · Avg loss: -10.37 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 27.00 |
| 07022026 | 5 | 3L/2S | 60.25 |
| 07062026 | 5 | 5L/0S | 2.75 |
| 07072026 | 5 | 5L/0S | 3.00 |
| 07082026 | 5 | 5L/0S | 0.25 |
| 07092026 | 5 | 5L/0S | 0.25 |
| 07132026 | 5 | 3L/2S | 60.00 |
| 07142026 | 5 | 5L/0S | 26.25 |
| 07152026 | 5 | 5L/0S | 21.75 |
| 07162026 | 5 | 5L/0S | 23.00 |

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

Wins: 6 · Losses: 24 · Avg win: 41.67 pts · Avg loss: -11.63 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 21.00 |
| 07022026 | 5 | 5L/0S | 62.75 |
| 07062026 | 5 | 5L/0S | 0.75 |
| 07072026 | 5 | 5L/0S | 27.75 |
| 07082026 | 5 | 5L/0S | 1.25 |
| 07092026 | 5 | 5L/0S | 0.00 |
| 07132026 | 5 | 5L/0S | 23.25 |
| 07142026 | 5 | 5L/0S | 1.50 |
| 07152026 | 5 | 5L/0S | 6.00 |
| 07162026 | 5 | 3L/2S | 65.50 |

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

Wins: 6 · Losses: 22 · Avg win: 28.04 pts · Avg loss: -9.16 pts

### Setup stability

| Day | Runs | Sides | Entry spread |
|---|---|---|---|
| 07012026 | 5 | 5L/0S | 3.50 |
| 07022026 | 5 | 5L/0S | 61.25 |
| 07062026 | 5 | 5L/0S | 2.75 |
| 07072026 | 5 | 5L/0S | 25.25 |
| 07082026 | 5 | 5L/0S | 94.00 |
| 07092026 | 5 | 5L/0S | 4.75 |
| 07132026 | 5 | 5L/0S | 1.50 |
| 07142026 | 5 | 5L/0S | 24.75 |
| 07152026 | 5 | 5L/0S | 42.75 |
| 07162026 | 5 | 4L/1S | 70.50 |

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
| basehit-trader | fable | 50 | 10 | 5 | ok |
| context-trader | fable | 50 | 10 | 5 | ok |
| context-trader | opus | 50 | 10 | 5 | ok |
| context-trader | sonnet | 50 | 10 | 5 | ok |
| placement-trader | fable | 50 | 10 | 5 | ok |
| placement-trader | opus | 50 | 10 | 5 | ok |
| placement-trader | sonnet | 50 | 10 | 5 | ok |
| rotation-trader | fable | 50 | 10 | 5 | ok |
