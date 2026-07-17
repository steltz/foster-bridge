import { minutesOfDayForTimestamp } from './session.js';

// Replays candles chronologically for a single order.
// Rules (see spec): touch = fill at entry price; the fill candle itself is
// checked for exits; SL is checked before TP so an ambiguous candle that
// spans both resolves to the worst case; still-open positions close at the
// final candle's close (EOD).
//
// options.openMinutes and options.cutoffMinutes (with options.tz) bound the
// local time-of-day window in which NEW entries may fill: no entry before
// openMinutes and none at or after cutoffMinutes. An order that could only
// fill outside that window is NOT_FILLED. Exits on an already-filled position
// are never blocked. A null bound disables that side of the window.
//
// Entries are resting LIMIT orders and fill only on a touch from the correct
// side: a long fills when price trades DOWN to the entry (a pullback into
// support), a short when price trades UP to the entry (a rally into
// resistance). Price already past the entry on the wrong side when it becomes
// active does not fill; it only becomes eligible again after returning to the
// correct side ("armed"). Only in-window candles arm or fill an order.
export function simulateOrder(order, candles, options = {}) {
  const { side, entry, stopLoss, takeProfit } = order;
  const { openMinutes = null, cutoffMinutes = null, tz = 'UTC' } = options;
  let fillTime = null;
  let armed = false; // has price been on the entry's correct side, in-window?

  for (const candle of candles) {
    if (fillTime === null) {
      const localMinutes =
        openMinutes === null && cutoffMinutes === null
          ? null
          : minutesOfDayForTimestamp(candle.time, tz);
      const afterOpen = openMinutes === null || localMinutes >= openMinutes;
      const beforeCutoff = cutoffMinutes === null || localMinutes < cutoffMinutes;
      if (!afterOpen || !beforeCutoff) continue; // not active for entry

      if (side === 'long') {
        const touch = candle.low <= entry;
        if (touch && (armed || candle.open >= entry)) {
          fillTime = candle.time;
        } else {
          if (candle.high >= entry) armed = true; // price reached the correct side
          continue;
        }
      } else {
        const touch = candle.high >= entry;
        if (touch && (armed || candle.open <= entry)) {
          fillTime = candle.time;
        } else {
          if (candle.low <= entry) armed = true;
          continue;
        }
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

export function simulate(candles, orders, multiplier, options = {}) {
  const results = orders.map((order) => {
    const outcome = simulateOrder(order, candles, options);
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
