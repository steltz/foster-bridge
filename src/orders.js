// Validates raw parsed-JSON orders and fills in defaults (id, qty).
export function normalizeOrders(raw) {
  if (!Array.isArray(raw)) throw new Error('Orders file must be a JSON array');
  const counters = { long: 0, short: 0 };
  const seen = new Set();

  return raw.map((order, i) => {
    const where = `Order ${i + 1}`;
    if (order === null || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error(`${where}: must be an object`);
    }
    const { side } = order;
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
    counters[side] += 1;
    const id = order.id === undefined ? `${side}-${counters[side]}` : String(order.id);
    if (seen.has(id)) throw new Error(`Duplicate order id: "${id}"`);
    seen.add(id);
    return { id, side, entry, stopLoss, takeProfit, qty };
  });
}
