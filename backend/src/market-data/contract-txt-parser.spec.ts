import { etWallTimeToEpochSeconds, parseContractTxt } from './contract-txt-parser';

describe('etWallTimeToEpochSeconds', () => {
  it('converts EST wall time (UTC-5)', () => {
    // 2026-01-15 10:00:00 ET == 15:00 UTC
    expect(etWallTimeToEpochSeconds(2026, 1, 15, 10, 0, 0)).toBe(Date.UTC(2026, 0, 15, 15, 0, 0) / 1000);
  });

  it('converts EDT wall time (UTC-4)', () => {
    // 2026-07-15 10:00:00 ET == 14:00 UTC
    expect(etWallTimeToEpochSeconds(2026, 7, 15, 10, 0, 0)).toBe(Date.UTC(2026, 6, 15, 14, 0, 0) / 1000);
  });

  it('is correct across the spring-forward transition (2026-03-08)', () => {
    // 01:59 ET is still EST (UTC-5); 03:00 ET is EDT (UTC-4).
    expect(etWallTimeToEpochSeconds(2026, 3, 8, 1, 59, 0)).toBe(Date.UTC(2026, 2, 8, 6, 59, 0) / 1000);
    expect(etWallTimeToEpochSeconds(2026, 3, 8, 3, 0, 0)).toBe(Date.UTC(2026, 2, 8, 7, 0, 0) / 1000);
  });
});

describe('parseContractTxt', () => {
  it('parses headerless datetime rows with volume, sorted by time', () => {
    const text = [
      '2026-06-15 09:35:00,7500.25,7501.0,7499.5,7500.0,321',
      '2026-06-15 09:30:00,7498.0,7500.5,7497.75,7500.25,955',
      '',
    ].join('\n');
    const candles = parseContractTxt(text);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: etWallTimeToEpochSeconds(2026, 6, 15, 9, 30, 0),
      open: 7498.0, high: 7500.5, low: 7497.75, close: 7500.25, volume: 955,
    });
    expect(candles[1].volume).toBe(321);
    expect(candles[1].time).toBeGreaterThan(candles[0].time);
  });

  it('every parsed candle carries volume (required, not optional)', () => {
    const candles = parseContractTxt('2026-06-15 09:30:00,1,2,0.5,1.5,0\n');
    // Zero is a legitimate volume for a quiet bar and must survive as 0, not
    // be dropped or treated as missing.
    expect(candles[0].volume).toBe(0);
  });

  it('rejects a malformed row with line context', () => {
    const text = [
      '2026-06-15 09:30:00,7498.0,7500.5,7497.75,7500.25,955',
      '2026-06-15 09:35:00,notanumber,7501.0,7499.5,7500.0,321',
    ].join('\n');
    expect(() => parseContractTxt(text)).toThrow('line 2');
  });

  it('rejects a whitespace-only numeric field (Number(" ") === 0 must not slip through)', () => {
    expect(() => parseContractTxt('2026-06-15 09:30:00, ,7501.0,7499.5,7500.0,321')).toThrow('line 1');
  });

  it('rejects rows without the expected shape', () => {
    expect(() => parseContractTxt('time,open,high,low,close\n123,1,2,3,4')).toThrow('line 1');
  });

  it('rejects empty input', () => {
    expect(() => parseContractTxt('\n\n')).toThrow('no data rows');
  });
});
