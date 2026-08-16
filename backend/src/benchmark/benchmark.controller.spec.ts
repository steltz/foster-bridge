import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BenchmarkController } from './benchmark.controller';
import { BenchmarkService } from './benchmark.service';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository } from './benchmark.repository';
import { SamplesService } from './samples.service';

async function build() {
  const service = { run: jest.fn().mockResolvedValue({ batchesSubmitted: 1, cellsQueued: 5, daysSkipped: [] }) };
  const scoreboard = { generate: jest.fn().mockResolvedValue({ markdown: '# x', json: {}, generatedAt: 't' }) };
  const repo = {
    nonTerminalBatches: jest.fn().mockResolvedValue([{ batchId: 'b1', day: '07012026', status: 'submitted', customIdToCell: { a: { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g' }, b: { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g' } } }]),
    getScoreboard: jest.fn().mockResolvedValue({ markdown: '# saved', json: {}, generatedAt: 't' }),
  };
  const config = { get: jest.fn().mockReturnValue('claude-fable-5') };
  const samples = {
    create: jest.fn().mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' }),
    list: jest.fn().mockResolvedValue([{ name: 's1', count: 1, poolSize: 10, firstDay: '01062025', lastDay: '01062025', createdAt: 't' }]),
    get: jest.fn().mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [BenchmarkController],
    providers: [
      { provide: BenchmarkService, useValue: service },
      { provide: ScoreboardService, useValue: scoreboard },
      { provide: BenchmarkRepository, useValue: repo },
      { provide: ConfigService, useValue: config },
      { provide: SamplesService, useValue: samples },
    ],
  }).compile();
  return { ctrl: moduleRef.get(BenchmarkController), service, scoreboard, repo, config, samples };
}

describe('BenchmarkController', () => {
  it('POST /benchmark/run forwards options to the service', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.run({ model: 'fable', runCount: 3, variants: ['base'] });
    expect(service.run).toHaveBeenCalledWith({ model: 'fable', runCount: 3, variants: ['base'], days: undefined });
    expect(res.cellsQueued).toBe(5);
  });

  it('GET /benchmark/status returns non-terminal batches with cell counts', async () => {
    const { ctrl } = await build();
    const status = await ctrl.status();
    expect(status.batches[0]).toMatchObject({ batchId: 'b1', status: 'submitted', cellCount: 2 });
  });

  it('GET /benchmark/scoreboard returns the saved scoreboard when present', async () => {
    const { ctrl } = await build();
    const sb = await ctrl.scoreboard('fable');
    expect(sb.markdown).toBe('# saved');
  });

  it('GET /benchmark/scoreboard 404s when no model has been scored', async () => {
    const { ctrl, repo } = await build();
    repo.getScoreboard.mockResolvedValue(null);
    await expect(ctrl.scoreboard('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET /benchmark/scoreboard with no model param defaults to the configured benchmark model', async () => {
    const { ctrl, repo, config } = await build();
    config.get.mockReturnValue('claude-fable-5');
    await ctrl.scoreboard(undefined);
    expect(config.get).toHaveBeenCalledWith('benchmark.model');
    expect(repo.getScoreboard).toHaveBeenCalledWith('fable');
  });

  it('GET /benchmark/scoreboard normalizes a full model id to its alias', async () => {
    const { ctrl, repo } = await build();
    await ctrl.scoreboard('claude-fable-5');
    expect(repo.getScoreboard).toHaveBeenCalledWith('fable');
  });
});

describe('BenchmarkController samples', () => {
  it('POST /benchmark/samples forwards the body to the service', async () => {
    const { ctrl, samples } = await build();
    const res = await ctrl.createSample({ name: 's1', count: 100, from: '01012025', to: '12312026' });
    expect(samples.create).toHaveBeenCalledWith({ name: 's1', count: 100, from: '01012025', to: '12312026' });
    expect(res.name).toBe('s1');
  });

  it('GET /benchmark/samples lists summaries', async () => {
    const { ctrl, samples } = await build();
    const res = await ctrl.listSamples();
    expect(samples.list).toHaveBeenCalled();
    expect(res[0].name).toBe('s1');
  });

  it('GET /benchmark/samples/:name fetches one sample', async () => {
    const { ctrl, samples } = await build();
    const res = await ctrl.getSample('s1');
    expect(samples.get).toHaveBeenCalledWith('s1');
    expect(res.days).toEqual(['01062025']);
  });

  it('service errors pass through unwrapped', async () => {
    const { ctrl, samples } = await build();
    const conflict = new ConflictException('exists');
    samples.create.mockRejectedValue(conflict);
    await expect(ctrl.createSample({ name: 's1' })).rejects.toBe(conflict);
    const notFound = new NotFoundException('nope');
    samples.get.mockRejectedValue(notFound);
    await expect(ctrl.getSample('nope')).rejects.toBe(notFound);
  });
});
