# Trader Scoreboard

120 cells · 4 trader@model groups. Every group is scored alone; P&L is never combined across traders or models.

## Ranking (mean net USD per run)

| # | Trader | Model | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | placement-trader | fable | 10 | 1 | 167.50 | 0.00 | 167.50 | 167.50 | 33% | 60% |
| 2 | context-trader | fable | 10 | 1 | 48.75 | 0.00 | 48.75 | 48.75 | 25% | 40% |
| 3 | placement-trader | sonnet | 10 | 5 | -29.00 | 73.27 | -111.25 | 76.25 | 20% | 60% |
| 4 | context-trader | sonnet | 10 | 5 | -33.25 | 100.29 | -133.75 | 120.00 | 21% | 56% |

## placement-trader @ fable

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 33.5 | 167.50 |

Wins: 2 · Losses: 4 · Avg win: 30.88 pts · Avg loss: -7.06 pts

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

### Pipeline errors

None.

## context-trader @ fable

| Run | Days | Pts | USD |
|---|---|---|---|
| 1 | 10 | 9.75 | 48.75 |

Wins: 1 · Losses: 3 · Avg win: 32.25 pts · Avg loss: -7.50 pts

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

## Coverage

| Trader | Model | Cells | Days | Runs | Status |
|---|---|---|---|---|---|
| context-trader | fable | 10 | 10 | 1 | ⚠ under-tested (max 50) |
| context-trader | sonnet | 50 | 10 | 5 | ok |
| placement-trader | fable | 10 | 10 | 1 | ⚠ under-tested (max 50) |
| placement-trader | sonnet | 50 | 10 | 5 | ok |
