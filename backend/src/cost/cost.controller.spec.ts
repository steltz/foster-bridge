import { CostController } from './cost.controller';

describe('CostController', () => {
  const service = {
    summarize: jest.fn().mockResolvedValue({ groupBy: 'tier', totalUsd: 1, totalRecords: 2, grossCacheReadDiscountUsd: 0, netCacheBenefitUsd: 0, groups: [] }),
    list: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
  };
  const builder = jest.fn().mockReturnValue('<!doctype html>...');
  const ctrl = new CostController(service as any, { build: builder } as any);

  afterEach(() => jest.clearAllMocks());

  it('summary defaults groupBy to operation and passes filters through', async () => {
    await ctrl.summary(undefined, 'fable', '2026-07-01', '2026-08-01');
    expect(service.summarize).toHaveBeenCalledWith({ groupBy: 'operation', model: 'fable', from: '2026-07-01', to: '2026-08-01' });
  });

  it('rejects an invalid groupBy', async () => {
    await expect(ctrl.summary('nonsense' as any, undefined, undefined, undefined)).rejects.toBeDefined();
  });

  it('records applies a limit/offset window', async () => {
    const out = await ctrl.records(undefined, undefined, undefined, '2', '1');
    expect(out.total).toBe(3);
    expect(out.records).toHaveLength(2);
  });

  it('report returns the builder HTML', async () => {
    const html = await ctrl.report(undefined, undefined, undefined);
    expect(html).toContain('<!doctype html>');
    expect(builder).toHaveBeenCalled();
  });
});
