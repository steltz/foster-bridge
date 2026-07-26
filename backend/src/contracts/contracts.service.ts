import { Injectable, NotFoundException } from '@nestjs/common';
import { CONTRACTS, ContractSpec } from './contracts.constants';

@Injectable()
export class ContractsService {
  get(symbol: string): ContractSpec {
    const spec = CONTRACTS[symbol];
    if (!spec) throw new NotFoundException(`Unknown contract symbol: ${symbol}`);
    return spec;
  }
  has(symbol: string): boolean {
    return Object.prototype.hasOwnProperty.call(CONTRACTS, symbol);
  }
  list(): ContractSpec[] {
    return Object.values(CONTRACTS);
  }
}
