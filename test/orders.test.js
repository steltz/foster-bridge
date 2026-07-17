import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrders } from '../src/orders.js';

test('normalizes a valid long and short with defaults', () => {
  const orders = normalizeOrders([
    { side: 'long', entry: 7530, stopLoss: 7520, takeProfit: 7550 },
    { id: 'fade', side: 'short', entry: 7560, stopLoss: 7570, takeProfit: 7540, qty: 2 },
  ]);
  assert.deepEqual(orders, [
    { id: 'long-1', side: 'long', entry: 7530, stopLoss: 7520, takeProfit: 7550, qty: 1 },
    { id: 'fade', side: 'short', entry: 7560, stopLoss: 7570, takeProfit: 7540, qty: 2 },
  ]);
});

test('rejects non-array input', () => {
  assert.throws(() => normalizeOrders({}), /must be a JSON array/);
});

test('rejects an invalid side', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'buy', entry: 1, stopLoss: 0, takeProfit: 2 }]),
    /Order 1: side must be "long" or "short"/
  );
});

test('rejects a non-numeric field', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'long', entry: '7530', stopLoss: 7520, takeProfit: 7550 }]),
    /Order 1: entry must be a number/
  );
});

test('rejects a long with SL/TP on the wrong side of entry', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'long', entry: 7530, stopLoss: 7540, takeProfit: 7550 }]),
    /long requires stopLoss < entry < takeProfit/
  );
});

test('rejects a short with SL/TP on the wrong side of entry', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'short', entry: 7530, stopLoss: 7520, takeProfit: 7510 }]),
    /short requires takeProfit < entry < stopLoss/
  );
});

test('rejects a bad qty', () => {
  assert.throws(
    () => normalizeOrders([{ side: 'long', entry: 1, stopLoss: 0, takeProfit: 2, qty: 0 }]),
    /qty must be a positive integer/
  );
});

test('rejects duplicate ids', () => {
  assert.throws(
    () => normalizeOrders([
      { id: 'a', side: 'long', entry: 1, stopLoss: 0, takeProfit: 2 },
      { id: 'a', side: 'long', entry: 1, stopLoss: 0, takeProfit: 2 },
    ]),
    /Duplicate order id: "a"/
  );
});
