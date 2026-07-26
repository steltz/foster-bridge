import { NotFoundException } from '@nestjs/common';
import { ContractsService } from './contracts.service';

describe('ContractsService', () => {
  const service = new ContractsService();

  it('get() returns the spec for a known symbol', () => {
    expect(service.get('MES').pointValue).toBe(5);
    expect(service.get('ES').pointValue).toBe(50);
    expect(service.get('MES').rth).toEqual({ open: '09:30', close: '16:00' });
  });

  it('get() throws NotFoundException for an unknown symbol', () => {
    expect(() => service.get('XYZ')).toThrow(NotFoundException);
  });

  it('has() reflects membership', () => {
    expect(service.has('NQ')).toBe(true);
    expect(service.has('XYZ')).toBe(false);
  });

  it('list() returns every seeded contract', () => {
    const symbols = service.list().map((c) => c.symbol).sort();
    expect(symbols).toEqual(['ES', 'MES', 'MNQ', 'NQ']);
  });
});
