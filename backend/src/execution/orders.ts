export type Side = 'long' | 'short';

// One trigger, up to two effects (see docs/order-contract-v2.md §1). At least
// one of takeFraction / moveStopToR must be present. All values are in R units
// (R = |entry - initial stopLoss|); normalization converts to absolute prices.
export interface ManagementRule {
  triggerR: number;
  takeFraction?: number;
  moveStopToR?: number;
}

export interface NormalizedManagement {
  triggerR: number;
  takeFraction: number | null;
  moveStopToR: number | null;
  triggerPrice: number;
  newStop: number | null;
}

export interface RawOrder {
  id?: string | number;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty?: number;
  activeFrom?: string; // 'HH:MM' local (session tz); no entry fill before this
  management?: ManagementRule[]; // v1: at most one rule
}

export interface NormalizedOrder {
  id: string;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
  // Present only when the raw order carried them — absent otherwise, so
  // pre-v2 orders normalize to exactly their pre-v2 shape.
  activeFromMinutes?: number;
  management?: NormalizedManagement[];
}

// Validates raw orders and fills in defaults (id, qty).
export function normalizeOrders(raw: unknown): NormalizedOrder[] {
  if (!Array.isArray(raw)) throw new Error('Orders file must be a JSON array');
  const counters: Record<Side, number> = { long: 0, short: 0 };
  const seen = new Set<string>();

  return raw.map((order: any, i: number) => {
    const where = `Order ${i + 1}`;
    if (order === null || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error(`${where}: must be an object`);
    }
    const side = order.side;
    if (side !== 'long' && side !== 'short') {
      throw new Error(`${where}: side must be "long" or "short"`);
    }
    for (const field of ['entry', 'stopLoss', 'takeProfit']) {
      if (typeof order[field] !== 'number' || !Number.isFinite(order[field])) {
        throw new Error(`${where}: ${field} must be a number`);
      }
    }
    const { entry, stopLoss, takeProfit } = order;
    if (side === 'long' && !(stopLoss < entry && entry < takeProfit)) {
      throw new Error(`${where}: long requires stopLoss < entry < takeProfit`);
    }
    if (side === 'short' && !(takeProfit < entry && entry < stopLoss)) {
      throw new Error(`${where}: short requires takeProfit < entry < stopLoss`);
    }
    let qty = 1;
    if (order.qty !== undefined) {
      if (!Number.isInteger(order.qty) || order.qty < 1) {
        throw new Error(`${where}: qty must be a positive integer`);
      }
      qty = order.qty;
    }
    counters[side as Side] += 1;
    const id = order.id === undefined ? `${side}-${counters[side as Side]}` : String(order.id);
    if (seen.has(id)) throw new Error(`Duplicate order id: "${id}"`);
    seen.add(id);

    const normalized: NormalizedOrder = { id, side, entry, stopLoss, takeProfit, qty };
    if (order.activeFrom !== undefined) {
      normalized.activeFromMinutes = parseActiveFrom(order.activeFrom, where);
    }
    if (order.management !== undefined) {
      normalized.management = normalizeManagement(order.management, { side, entry, stopLoss, takeProfit }, where);
    }
    return normalized;
  });
}

function parseActiveFrom(value: unknown, where: string): number {
  const match = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value) : null;
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) {
    throw new Error(`${where}: activeFrom must be a 24-hour HH:MM time`);
  }
  return hour * 60 + minute;
}

// Validates the v1 management shape (docs/order-contract-v2.md §1.3) and
// converts R-unit inputs to the absolute prices the engine and trade sheet
// consume — this is the ONLY place R math happens.
function normalizeManagement(
  raw: unknown,
  order: { side: Side; entry: number; stopLoss: number; takeProfit: number },
  where: string,
): NormalizedManagement[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: management must be an array`);
  if (raw.length > 1) throw new Error(`${where}: at most one management rule is supported`);
  if (raw.length === 0) return [];

  const rule: any = raw[0];
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${where}: management rule must be an object`);
  }
  const { triggerR, takeFraction, moveStopToR } = rule;
  if (typeof triggerR !== 'number' || !Number.isFinite(triggerR) || triggerR <= 0) {
    throw new Error(`${where}: triggerR must be a number > 0`);
  }
  if (takeFraction === undefined && moveStopToR === undefined) {
    throw new Error(`${where}: management rule must set takeFraction or moveStopToR`);
  }
  if (takeFraction !== undefined) {
    if (typeof takeFraction !== 'number' || !Number.isFinite(takeFraction) || takeFraction <= 0 || takeFraction >= 1) {
      throw new Error(`${where}: takeFraction must be strictly between 0 and 1`);
    }
  }
  if (moveStopToR !== undefined) {
    if (typeof moveStopToR !== 'number' || !Number.isFinite(moveStopToR) || moveStopToR < 0 || moveStopToR >= triggerR) {
      throw new Error(`${where}: moveStopToR must be >= 0 and < triggerR`);
    }
  }

  const { side, entry, stopLoss, takeProfit } = order;
  const direction = side === 'long' ? 1 : -1;
  const risk = Math.abs(entry - stopLoss); // > 0, guaranteed by the ordering checks above
  const triggerPrice = entry + triggerR * risk * direction;
  const beyondTarget = side === 'long' ? triggerPrice >= takeProfit : triggerPrice <= takeProfit;
  if (beyondTarget) {
    throw new Error(
      `${where}: management trigger (${triggerPrice}) must be strictly before takeProfit (${takeProfit})`,
    );
  }
  return [
    {
      triggerR,
      takeFraction: takeFraction ?? null,
      moveStopToR: moveStopToR ?? null,
      triggerPrice,
      newStop: moveStopToR === undefined ? null : entry + moveStopToR * risk * direction,
    },
  ];
}
