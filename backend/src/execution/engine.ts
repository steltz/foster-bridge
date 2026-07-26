import { minutesOfDayForTimestamp } from '../common/session-time';
import { Candle } from '../market-data/candle';
import { NormalizedOrder, Side } from './orders';

// Replays candles chronologically for a single order.
// Rules (see spec): touch = fill at entry price; the fill candle itself is
// checked for exits; an ambiguous candle (one whose range spans both SL and
// TP) resolves via slHitsFirst's candle-shape heuristic below, not a blanket
// "SL always wins" rule; still-open positions close at the final candle's
// close (EOD).
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
// A bullish candle (close >= open) is assumed to have dipped to its low
// before rallying to its high (Open -> Low -> High -> Close); a bearish
// candle is assumed to have rallied to its high before dropping to its low
// (Open -> High -> Low -> Close). This is a property of the candle alone —
// never of the order's stop distance — so an ambiguous candle resolves the
// same way regardless of how tight a trader's stop is. A flat candle
// (close === open) is treated as bullish.
//
// Alongside fill/exit, two outcome-quality metrics are tracked in the same
// pass:
// - closestApproach: while still pending and in-window, the smallest
//   distance from entry the touch-side price (low for a long, high for a
//   short) reached. Only meaningful for NOT_FILLED (null otherwise); an
//   order that was never entry-eligible in any in-window candle gets null
//   here too, since "how close" has no answer without a candle to measure.
// - maxAdverseExcursion / maxFavorableExcursion: once filled, the worst/best
//   unrealized move (in points, using each candle's full high/low — the
//   same granularity the fill/exit rules already use) seen from the fill
//   candle through the exit candle inclusive. Both are null until filled.

export type OrderStatus = 'SL' | 'TP' | 'EOD' | 'NOT_FILLED';

export interface SimulateOptions {
  openMinutes?: number | null;
  cutoffMinutes?: number | null;
  tz?: string;
}

export interface OrderOutcome {
  status: OrderStatus;
  fillTime: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  maxAdverseExcursion: number | null;
  maxFavorableExcursion: number | null;
  rMultiple: number | null;
  closestApproach: number | null;
}

export interface SimResult extends NormalizedOrder, OrderOutcome {
  points: number | null;
  dollars: number | null;
}

export interface SimSummary {
  orders: number;
  filled: number;
  wins: number;
  losses: number;
  netPoints: number;
  netDollars: number;
}

function slHitsFirst(candle: Candle, side: Side): boolean {
  const bullish = candle.close >= candle.open;
  // long: SL sits on the low side, TP on the high side. short: mirrored.
  return side === 'long' ? bullish : !bullish;
}

export function simulateOrder(
  order: NormalizedOrder,
  candles: Candle[],
  options: SimulateOptions = {},
): OrderOutcome {
  const { side, entry, stopLoss, takeProfit } = order;
  const { openMinutes = null, cutoffMinutes = null, tz = 'UTC' } = options;
  const direction = side === 'long' ? 1 : -1;
  const riskDistance = Math.abs(entry - stopLoss);
  let fillTime: number | null = null;
  let armed = false; // has price been on the entry's correct side, in-window?
  let closestApproach: number | null = null;
  let maxAdverseExcursion = 0;
  let maxFavorableExcursion = 0;

  // rMultiple is deliberately qty-independent (a per-unit ratio), so it's
  // comparable across orders regardless of position size.
  const finish = (status: OrderStatus, exitTime: number, exitPrice: number): OrderOutcome => ({
    status,
    fillTime,
    exitTime,
    exitPrice,
    maxAdverseExcursion,
    maxFavorableExcursion,
    rMultiple: riskDistance === 0 ? null : ((exitPrice - entry) * direction) / riskDistance,
    closestApproach: null,
  });

  for (const candle of candles) {
    if (fillTime === null) {
      const localMinutes =
        openMinutes === null && cutoffMinutes === null ? null : minutesOfDayForTimestamp(candle.time, tz);
      const afterOpen = openMinutes === null || (localMinutes as number) >= openMinutes;
      const beforeCutoff = cutoffMinutes === null || (localMinutes as number) < cutoffMinutes;
      if (!afterOpen || !beforeCutoff) continue; // not active for entry

      const touchSidePrice = side === 'long' ? candle.low : candle.high;
      const distance = Math.abs(touchSidePrice - entry);
      if (closestApproach === null || distance < closestApproach) closestApproach = distance;

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

    const adverse = side === 'long' ? entry - candle.low : candle.high - entry;
    const favorable = side === 'long' ? candle.high - entry : entry - candle.low;
    if (adverse > maxAdverseExcursion) maxAdverseExcursion = adverse;
    if (favorable > maxFavorableExcursion) maxFavorableExcursion = favorable;

    const slHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss;
    const tpHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (slHit && tpHit) {
      return slHitsFirst(candle, side) ? finish('SL', candle.time, stopLoss) : finish('TP', candle.time, takeProfit);
    }
    if (slHit) return finish('SL', candle.time, stopLoss);
    if (tpHit) return finish('TP', candle.time, takeProfit);
  }

  if (fillTime === null) {
    return {
      status: 'NOT_FILLED',
      fillTime: null,
      exitTime: null,
      exitPrice: null,
      maxAdverseExcursion: null,
      maxFavorableExcursion: null,
      rMultiple: null,
      closestApproach,
    };
  }
  const last = candles[candles.length - 1];
  return finish('EOD', last.time, last.close);
}

export function simulate(
  candles: Candle[],
  orders: NormalizedOrder[],
  multiplier: number,
  options: SimulateOptions = {},
): { results: SimResult[]; summary: SimSummary } {
  const results: SimResult[] = orders.map((order) => {
    const outcome = simulateOrder(order, candles, options);
    let points: number | null = null;
    let dollars: number | null = null;
    if (outcome.status !== 'NOT_FILLED') {
      const direction = order.side === 'long' ? 1 : -1;
      points = ((outcome.exitPrice as number) - order.entry) * direction * order.qty;
      dollars = points * multiplier;
    }
    return { ...order, ...outcome, points, dollars };
  });

  const filled = results.filter((r) => r.status !== 'NOT_FILLED');
  const summary: SimSummary = {
    orders: results.length,
    filled: filled.length,
    wins: filled.filter((r) => (r.points as number) > 0).length,
    losses: filled.filter((r) => (r.points as number) < 0).length,
    netPoints: filled.reduce((sum, r) => sum + (r.points as number), 0),
    netDollars: filled.reduce((sum, r) => sum + (r.dollars as number), 0),
  };
  return { results, summary };
}
