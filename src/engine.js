// Replays candles chronologically for a single order.
// Rules (see spec): touch = fill at entry price; the fill candle itself is
// checked for exits; SL is checked before TP so an ambiguous candle that
// spans both resolves to the worst case; still-open positions close at the
// final candle's close (EOD).
export function simulateOrder(order, candles) {
  const { side, entry, stopLoss, takeProfit } = order;
  let fillTime = null;

  for (const candle of candles) {
    if (fillTime === null) {
      if (candle.low <= entry && entry <= candle.high) {
        fillTime = candle.time;
      } else {
        continue;
      }
    }
    const slHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss;
    if (slHit) return { status: 'SL', fillTime, exitTime: candle.time, exitPrice: stopLoss };

    const tpHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (tpHit) return { status: 'TP', fillTime, exitTime: candle.time, exitPrice: takeProfit };
  }

  if (fillTime === null) {
    return { status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null };
  }
  const last = candles[candles.length - 1];
  return { status: 'EOD', fillTime, exitTime: last.time, exitPrice: last.close };
}

export function simulate(candles, orders, multiplier) {
  const results = orders.map((order) => {
    const outcome = simulateOrder(order, candles);
    let points = null;
    let dollars = null;
    if (outcome.status !== 'NOT_FILLED') {
      const direction = order.side === 'long' ? 1 : -1;
      points = (outcome.exitPrice - order.entry) * direction * order.qty;
      dollars = points * multiplier;
    }
    return { ...order, ...outcome, points, dollars };
  });

  const filled = results.filter((r) => r.status !== 'NOT_FILLED');
  const summary = {
    orders: results.length,
    filled: filled.length,
    wins: filled.filter((r) => r.points > 0).length,
    losses: filled.filter((r) => r.points < 0).length,
    netPoints: filled.reduce((sum, r) => sum + r.points, 0),
    netDollars: filled.reduce((sum, r) => sum + r.dollars, 0),
  };
  return { results, summary };
}
