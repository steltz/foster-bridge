import { Injectable } from '@nestjs/common';
import { Candle } from '../market-data/candle';
import { NormalizedOrder } from './orders';
import { simulate, simulateOrder, SimulateOptions } from './engine';

@Injectable()
export class ExecutionEngine {
  simulate(candles: Candle[], orders: NormalizedOrder[], multiplier: number, options: SimulateOptions = {}) {
    return simulate(candles, orders, multiplier, options);
  }

  simulateOrder(order: NormalizedOrder, candles: Candle[], options: SimulateOptions = {}) {
    return simulateOrder(order, candles, options);
  }
}
