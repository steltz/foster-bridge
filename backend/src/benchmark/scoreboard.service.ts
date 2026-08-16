import { Injectable } from '@nestjs/common';
import { BenchmarkRepository, ScoreboardDoc } from './benchmark.repository';
import { CloudInputsService } from './cloud-inputs.service';
import { computeScoreboard, renderScoreboard, ScoreCell } from './scoreboard/scoreboard';

@Injectable()
export class ScoreboardService {
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: CloudInputsService,
  ) {}

  async generate(modelAlias: string): Promise<ScoreboardDoc> {
    const cells = await this.repo.listCells(modelAlias);
    // BenchmarkCell already carries every field the pure functions read.
    const scoreCells = cells as ScoreCell[];
    const sb = computeScoreboard(scoreCells);
    const snap = await this.inputs.snapshot();
    const traders = snap.traders.map((t) => ({ name: t.name, origin: t.origin, mutation: t.mutation }));
    const features = snap.features.map((f) => ({ id: f.id, name: f.name }));
    const markdown = renderScoreboard(sb, traders, features);
    const doc: ScoreboardDoc = { json: sb, markdown, generatedAt: new Date().toISOString() };
    await this.repo.saveScoreboard(modelAlias, doc);
    return doc;
  }
}
