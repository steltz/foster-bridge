import { Injectable, NotFoundException } from '@nestjs/common';
import { CONTRACTS, ContractSpec } from './contracts.constants';

@Injectable()
export class ContractsService {
  get(symbol: string): ContractSpec {
    if (!this.has(symbol)) {
      throw new NotFoundException(`Unknown contract symbol: ${symbol}`);
    }
    return CONTRACTS[symbol];
  }
  has(symbol: string): boolean {
    return Object.prototype.hasOwnProperty.call(CONTRACTS, symbol);
  }
  list(): ContractSpec[] {
    return Object.values(CONTRACTS);
  }
}
