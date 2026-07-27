import { Test } from '@nestjs/testing';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { BenchmarkCell } from './benchmark.types';

function cell(o: Partial<BenchmarkCell> = {}): BenchmarkCell {
  return {
    trader: 'context-trader', model: { alias: 'fable', id: 'claude-fable-5' }, modelAlias: 'fable',
    day: '07012026', date: '2026-07-01', variant: 'base', runIndex: 1,
    personaSha256: 'p', generalSha256: 'g',
    setup: { side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 },
    result: { status: 'TP', points: 10, dollars: 50 }, createdAt: 't',
    ...o,
  };
}

async function build(cells: BenchmarkCell[]) {
  const repo = { listCells: jest.fn().mockResolvedValue(cells), saveScoreboard: jest.fn().mockResolvedValue(undefined), getScoreboard: jest.fn() };
  const inputs = {
    collectTraders: jest.fn().mockReturnValue([{ name: 'context-trader', origin: null, mutation: null }]),
    collectFeatures: jest.fn().mockReturnValue([{ id: 'seven-keys-method', name: 'Seven-Keys methodology' }]),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ScoreboardService,
      { provide: BenchmarkRepository, useValue: repo },
      { provide: RepoInputsService, useValue: inputs },
    ],
  }).compile();
  return { svc: moduleRef.get(ScoreboardService), repo };
}

describe('ScoreboardService.generate', () => {
  it('computes, renders and saves the scoreboard for a model', async () => {
    const { svc, repo } = await build([cell({ runIndex: 1 }), cell({ runIndex: 2, result: { status: 'SL', points: -5, dollars: -25 } })]);
    const out = await svc.generate('fable');
    expect(repo.listCells).toHaveBeenCalledWith('fable');
    expect(out.markdown).toContain('# Trader Scoreboard');
    expect(repo.saveScoreboard).toHaveBeenCalledWith('fable', expect.objectContaining({ markdown: expect.any(String), json: expect.any(Object) }));
  });

  it('handles an empty cell set without throwing', async () => {
    const { svc, repo } = await build([]);
    const out = await svc.generate('fable');
    expect(out.markdown).toContain('# Trader Scoreboard');
    expect((out.json as { groups: unknown[] }).groups).toEqual([]);
    expect(repo.saveScoreboard).toHaveBeenCalledWith('fable', expect.objectContaining({ markdown: expect.any(String), json: expect.any(Object) }));
  });
});
