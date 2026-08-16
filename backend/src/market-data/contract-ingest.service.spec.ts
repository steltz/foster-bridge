import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  ContractIngestService,
  ContractIngestAlreadyRunningError,
  ContractIngestNoFilesError,
  mapContractFile,
} from './contract-ingest.service';

describe('mapContractFile', () => {
  it.each([
    ['ES_U26_1min.txt', { symbol: 'ESU26', interval: 'min-1' }],
    ['ES_H25_5min.txt', { symbol: 'ESH25', interval: 'min-5' }],
  ] as const)('%s -> %o', (name, expected) => {
    expect(mapContractFile(name)).toEqual(expected);
  });

  it('returns null for non-matching names', () => {
    expect(mapContractFile('README.md')).toBeNull();
    expect(mapContractFile('ES_X26_1min.txt')).toBeNull();
    expect(mapContractFile('NQ_U26_1min.txt')).toBeNull();
  });
});

describe('ContractIngestService', () => {
  let root: string;
  const ingested: { symbol: string; interval: string; count: number }[] = [];
  const marketData = {
    ingestCandles: jest.fn(async (symbol: string, interval: string, candles: unknown[]) => {
      ingested.push({ symbol, interval, count: candles.length });
      return { symbol, interval, totalRows: candles.length, days: [{ date: '2026-06-15', added: candles.length, updated: 0, unchanged: false, totalAfter: candles.length, complete: false }] };
    }),
  };

  function build(): ContractIngestService {
    const config = { get: (key: string) => (key === 'marketData.contractDataRoot' ? root : undefined) } as unknown as ConfigService;
    return new ContractIngestService(marketData as never, config);
  }

  beforeEach(() => {
    ingested.length = 0;
    marketData.ingestCandles.mockClear();
    root = mkdtempSync(join(tmpdir(), 'contract-ingest-'));
    // Asserts archive-dirs-before-update-dirs ordering (the property
    // last-write-wins rides on, should a contract ever appear in both —
    // none does today; upsert-level overwrite itself is upsertDay's job
    // and is not observable through the mocked ingestCandles).
    for (const dir of ['ES_5min_archive_t6h13g', 'ES_5min_update_t6h13g']) {
      mkdirSync(join(root, 'data', dir), { recursive: true });
    }
    writeFileSync(
      join(root, 'data', 'ES_5min_archive_t6h13g', 'ES_M25_5min.txt'),
      '2025-06-02 09:30:00,6000,6001,5999,6000.5,10\n',
    );
    writeFileSync(
      join(root, 'data', 'ES_5min_update_t6h13g', 'ES_U26_5min.txt'),
      '2026-06-15 09:30:00,7500,7501,7499,7500.5,10\n2026-06-15 09:35:00,7500.5,7502,7500,7501,12\n',
    );
    writeFileSync(join(root, 'data', 'ES_5min_update_t6h13g', 'notes.txt'), 'not a contract file\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('walks dirs (archive first), maps files, ingests, and reports per-file results', async () => {
    const svc = build();
    const snap = svc.start();
    expect(snap.state).toBe('running');
    await svc.loopPromise;

    const done = svc.snapshot()!;
    expect(done.state).toBe('done');
    expect(done.counts.files).toBe(2); // notes.txt skipped, not counted as a contract file
    expect(done.counts.processed).toBe(2);
    expect(done.counts.failed).toBe(0);
    expect(done.skipped).toContain('ES_5min_update_t6h13g/notes.txt');
    // Archive before update.
    expect(ingested.map((r) => r.symbol)).toEqual(['ESM25', 'ESU26']);
    expect(ingested[1]).toEqual({ symbol: 'ESU26', interval: 'min-5', count: 2 });
  });

  it('isolates a file failure and continues', async () => {
    writeFileSync(join(root, 'data', 'ES_5min_archive_t6h13g', 'ES_H25_5min.txt'), 'garbage row\n');
    const svc = build();
    svc.start();
    await svc.loopPromise;
    const done = svc.snapshot()!;
    expect(done.state).toBe('done');
    expect(done.counts.failed).toBe(1);
    const failed = done.results.find((r) => r.file.endsWith('ES_H25_5min.txt'))!;
    expect(failed.error).toContain('line 1');
    // The good files still ingested (ESH25 failed at parse, so it never
    // reached ingestCandles; processed counts attempts, failed the subset).
    expect(done.counts.processed).toBe(3);
    expect(ingested.map((r) => r.symbol)).toEqual(['ESM25', 'ESU26']);
  });

  it('409s a second start while running', async () => {
    const svc = build();
    svc.start();
    expect(() => svc.start()).toThrow(ContractIngestAlreadyRunningError);
    await svc.loopPromise;
  });

  it('discovers dirs by pattern, not by name — the suffix is an opaque export token', async () => {
    mkdirSync(join(root, 'data', 'ES_5min_update_x9k2f'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'ES_5min_update_x9k2f', 'ES_Z26_5min.txt'),
      '2026-12-01 09:30:00,7600,7601,7599,7600.5,10\n',
    );
    const svc = build();
    svc.start();
    await svc.loopPromise;
    expect(ingested.map((r) => r.symbol)).toContain('ESZ26');
  });

  it('ignores a stray FILE whose name matches the dir pattern (no ENOTDIR crash)', async () => {
    writeFileSync(join(root, 'data', 'ES_5min_update_stray'), 'not a directory\n');
    const svc = build();
    svc.start();
    await svc.loopPromise;
    const done = svc.snapshot()!;
    expect(done.state).toBe('done');
    // The stray file contributes nothing; the real dirs still processed.
    expect(done.counts.files).toBe(2);
    expect(ingested.map((r) => r.symbol)).toEqual(['ESM25', 'ESU26']);
  });

  it('refuses to start when no contract files are found (misconfigured root must not look like success)', () => {
    rmSync(join(root, 'data'), { recursive: true, force: true });
    const svc = build();
    expect(() => svc.start()).toThrow(ContractIngestNoFilesError);
    expect(svc.snapshot()).toBeNull();
  });
});
