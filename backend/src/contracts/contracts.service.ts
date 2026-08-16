import { Injectable, NotFoundException } from '@nestjs/common';
import { CONTRACTS, ContractSpec } from './contracts.constants';

const QUARTERLY_RE = /^ES[HMUZ]\d{2}$/;

@Injectable()
export class ContractsService {
  get(symbol: string): ContractSpec {
    if (this.has(symbol)) return CONTRACTS[symbol];
    // Quarterly ES contracts (ESH25 ... ESZ27) derive from the ES base spec:
    // same tick, point value, timezone, RTH — only the symbol differs.
    if (QUARTERLY_RE.test(symbol)) return { ...CONTRACTS.ES, symbol };
    throw new NotFoundException(`Unknown contract symbol: ${symbol}`);
  }
  has(symbol: string): boolean {
    return Object.prototype.hasOwnProperty.call(CONTRACTS, symbol);
  }
  list(): ContractSpec[] {
    return Object.values(CONTRACTS);
  }
}
