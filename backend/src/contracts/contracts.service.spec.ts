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

  it('get() throws for inherited Object.prototype keys', () => {
    expect(() => service.get('constructor')).toThrow(NotFoundException);
    expect(() => service.get('toString')).toThrow(NotFoundException);
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

describe('quarterly contract symbols', () => {
  const svc = new ContractsService();

  it('derives a quarterly spec from the ES base', () => {
    const spec = svc.get('ESU26');
    expect(spec.symbol).toBe('ESU26');
    expect(spec.pointValue).toBe(50);
    expect(spec.tickSize).toBe(0.25);
    expect(spec.timezone).toBe('America/New_York');
    expect(spec.rth).toEqual({ open: '09:30', close: '16:00' });
  });

  it('rejects malformed quarterly-ish symbols', () => {
    for (const bad of ['ESX26', 'ESU2', 'ESU266', 'MESU26', 'esu26']) {
      expect(() => svc.get(bad)).toThrow('Unknown contract symbol');
    }
  });

  it('has() stays registry-only', () => {
    expect(svc.has('ESU26')).toBe(false);
    expect(svc.has('ES')).toBe(true);
  });
});
