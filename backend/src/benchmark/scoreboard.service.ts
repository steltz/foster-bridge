import { Injectable } from '@nestjs/common';
import { BenchmarkRepository, ScoreboardDoc } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { computeScoreboard, renderScoreboard, ScoreCell } from './scoreboard/scoreboard';

@Injectable()
export class ScoreboardService {
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
  ) {}

  async generate(modelAlias: string): Promise<ScoreboardDoc> {
    const cells = await this.repo.listCells(modelAlias);
    // BenchmarkCell already carries every field the pure functions read.
    const scoreCells = cells as ScoreCell[];
    const sb = computeScoreboard(scoreCells);
    const traders = this.inputs.collectTraders().map((t) => ({ name: t.name, origin: t.origin, mutation: t.mutation }));
    const features = this.inputs.collectFeatures().map((f) => ({ id: f.id, name: f.name }));
    const markdown = renderScoreboard(sb, traders, features);
    const doc: ScoreboardDoc = { json: sb, markdown, generatedAt: new Date().toISOString() };
    await this.repo.saveScoreboard(modelAlias, doc);
    return doc;
  }
}
