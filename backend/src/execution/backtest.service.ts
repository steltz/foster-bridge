import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ContractsService } from '../contracts/contracts.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ExecutionEngine } from './execution-engine';
import { RawOrder, normalizeOrders } from './orders';
import { SimResult, SimSummary } from './engine';
import { Interval, intervalToSeconds } from '../market-data/candle';
import { analyzeCoverage, CoverageResult } from '../market-data/coverage';
import { filterTimeWindow, hhmmToMinutes } from '../common/session-time';

export interface BacktestRequest {
  symbol: string;
  interval: Interval;
  date: string; // YYYY-MM-DD, ET calendar day
  session?: 'rth' | 'full';
  orders: RawOrder[];
  entryCutoff?: string; // 'HH:MM' or 'off'; default '14:00'
  openBuffer?: number;  // minutes after RTH open; default 30
  allowIncomplete?: boolean;
}

export interface BacktestResult {
  symbol: string;
  date: string;
  session: 'rth' | 'full';
  results: SimResult[];
  summary: SimSummary;
  coverage: CoverageResult;
}

function parseEntryCutoff(value: string): number | null {
  if (value === 'off' || value === 'none' || value === '') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) throw new Error('entryCutoff must be a 24-hour HH:MM time or "off"');
  return hour * 60 + minute;
}

@Injectable()
export class BacktestService {
  constructor(
    private readonly contracts: ContractsService,
    private readonly marketData: MarketDataService,
    private readonly engine: ExecutionEngine,
  ) {}

  async run(req: BacktestRequest): Promise<BacktestResult> {
    const spec = this.contracts.get(req.symbol); // 404 on unknown symbol
    // The RTH window is defined relative to the contract's own timezone; there
    // is no request-level override, which would desync the grid from spec.rth.
    const tz = spec.timezone;
    const session = req.session ?? 'rth';
    const orders = normalizeOrders(req.orders);

    const dayCandles = await this.marketData.getDay(req.symbol, req.interval, req.date);
    if (dayCandles === null || dayCandles.length === 0) {
      throw new NotFoundException(`No stored candle data for ${req.symbol} ${req.interval} ${req.date}`);
    }

    const rthOpen = hhmmToMinutes(spec.rth.open);
    const rthClose = hhmmToMinutes(spec.rth.close);
    const coverage = analyzeCoverage(dayCandles, {
      openMin: rthOpen, closeMin: rthClose, intervalSec: intervalToSeconds(req.interval), tz,
    });

    if (session === 'rth' && !coverage.complete && req.allowIncomplete !== true) {
      throw new UnprocessableEntityException({
        error: 'incomplete-session',
        message: `Incomplete RTH session for ${req.symbol} ${req.date}; refusing to backtest`,
        hasOpen: coverage.hasOpen, hasClose: coverage.hasClose, gaps: coverage.gaps,
      });
    }

    const sessionCandles = session === 'rth' ? filterTimeWindow(dayCandles, tz, rthOpen, rthClose) : dayCandles;

    const openMinutes = rthOpen + (req.openBuffer ?? 30);
    const cutoffMinutes = parseEntryCutoff(req.entryCutoff ?? '14:00');

    const { results, summary } = this.engine.simulate(sessionCandles, orders, spec.pointValue, {
      openMinutes, cutoffMinutes, tz,
    });

    return { symbol: req.symbol, date: req.date, session, results, summary, coverage };
  }
}
