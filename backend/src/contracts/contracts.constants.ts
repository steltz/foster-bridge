export interface ContractSpec {
  symbol: string;
  name: string;
  pointValue: number; // dollars per 1.0 point per contract (old --multiplier)
  tickSize: number;
  currency: string;
  timezone: string;
  rth: { open: string; close: string }; // 'HH:MM' local to `timezone`
}

export const CONTRACTS: Record<string, ContractSpec> = {
  MES: {
    symbol: 'MES',
    name: 'Micro E-mini S&P 500',
    pointValue: 5,
    tickSize: 0.25,
    currency: 'USD',
    timezone: 'America/New_York',
    rth: { open: '09:30', close: '16:00' },
  },
  ES: {
    symbol: 'ES',
    name: 'E-mini S&P 500',
    pointValue: 50,
    tickSize: 0.25,
    currency: 'USD',
    timezone: 'America/New_York',
    rth: { open: '09:30', close: '16:00' },
  },
  NQ: {
    symbol: 'NQ',
    name: 'E-mini Nasdaq-100',
    pointValue: 20,
    tickSize: 0.25,
    currency: 'USD',
    timezone: 'America/New_York',
    rth: { open: '09:30', close: '16:00' },
  },
  MNQ: {
    symbol: 'MNQ',
    name: 'Micro E-mini Nasdaq-100',
    pointValue: 2,
    tickSize: 0.25,
    currency: 'USD',
    timezone: 'America/New_York',
    rth: { open: '09:30', close: '16:00' },
  },
};
