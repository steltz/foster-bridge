import { resolveContract, rollSwitchMonday } from './contracts-roll';

describe('rollSwitchMonday', () => {
  // Expiration = third Friday; switch Monday = third Friday - 4 days.
  it.each([
    [2025, 3, '2025-03-17'],
    [2025, 6, '2025-06-16'],
    [2025, 9, '2025-09-15'],
    [2025, 12, '2025-12-15'],
    [2026, 3, '2026-03-16'],
    [2026, 6, '2026-06-15'],
    [2026, 9, '2026-09-14'],
  ] as const)('(%i, %i) -> %s', (year, month, expected) => {
    expect(rollSwitchMonday(year, month)).toBe(expected);
  });
});

describe('resolveContract', () => {
  // Every verified boundary row from docs/es-contract-roll-convention.md.
  it.each([
    ['2026-03-13', 'ESH26'], // Fri before switch — still front
    ['2026-03-16', 'ESM26'], // switch Monday
    ['2026-06-12', 'ESM26'],
    ['2026-06-15', 'ESU26'],
    ['2025-03-14', 'ESH25'],
    ['2025-03-17', 'ESM25'],
    ['2025-06-09', 'ESM25'],
    ['2025-06-17', 'ESU25'],
    ['2025-09-12', 'ESU25'],
    ['2025-09-15', 'ESZ25'], // Sep switch Monday itself
    ['2025-09-16', 'ESZ25'],
    ['2025-12-12', 'ESZ25'],
    ['2025-12-15', 'ESH26'], // Dec rolls into next year's Mar
  ])('%s -> %s', (date, expected) => {
    expect(resolveContract('ES', date)).toBe(expected);
  });

  it('maps non-quarterly months to the next quarterly (Apr -> Jun, Aug -> Sep)', () => {
    expect(resolveContract('ES', '2026-04-10')).toBe('ESM26');
    expect(resolveContract('ES', '2026-08-15')).toBe('ESU26');
  });

  it('handles the Dec -> Mar year boundary on both sides', () => {
    expect(resolveContract('ES', '2025-12-31')).toBe('ESH26');
    expect(resolveContract('ES', '2026-01-02')).toBe('ESH26');
  });

  it('rejects malformed dates', () => {
    expect(() => resolveContract('ES', '06/15/2026')).toThrow('YYYY-MM-DD');
    expect(() => resolveContract('ES', '2026-13-01')).toThrow();
  });
});
