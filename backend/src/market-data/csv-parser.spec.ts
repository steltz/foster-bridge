import { parseCsv } from './csv-parser';

describe('parseCsv', () => {
  it('parses OHLC and ignores indicator columns, sorted ascending', () => {
    const text = [
      'time,open,high,low,close,Extra Indicator',
      '1782878700,2,3,1,2,foo',
      '1782878400,1,2,0,1,bar',
    ].join('\n');
    const candles = parseCsv(text);
    expect(candles).toEqual([
      { time: 1782878400, open: 1, high: 2, low: 0, close: 1 },
      { time: 1782878700, open: 2, high: 3, low: 1, close: 2 },
    ]);
  });

  it('is case-insensitive on the header', () => {
    const text = 'Time,Open,High,Low,Close\n1782878400,1,2,0,1';
    expect(parseCsv(text)[0].time).toBe(1782878400);
  });

  it('throws when a required column is missing', () => {
    expect(() => parseCsv('time,open,high,low\n1,2,3,4')).toThrow('missing required column: close');
  });

  it('throws on a non-numeric cell', () => {
    const text = 'time,open,high,low,close\n1782878400,x,2,0,1';
    expect(() => parseCsv(text)).toThrow('invalid open value');
  });

  it('throws when there are no data rows', () => {
    expect(() => parseCsv('time,open,high,low,close')).toThrow('no data rows');
  });
});
