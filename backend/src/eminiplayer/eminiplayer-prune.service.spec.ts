import { Test } from '@nestjs/testing';
import { EminiplayerPruneService } from './eminiplayer-prune.service';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';

const PREFIX = 'knowledge-base/es';

type FakeFile = { name: string; delete: jest.Mock };

function makeBucket(paths: string[]) {
  const files = new Map<string, FakeFile>(
    paths.map((name) => [name, { name, delete: jest.fn(() => Promise.resolve()) }]),
  );
  return {
    files,
    getFiles: jest.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve([[...files.values()].filter((f) => f.name.startsWith(prefix))]),
    ),
  };
}

function deleted(bucket: ReturnType<typeof makeBucket>): string[] {
  return [...bucket.files.values()]
    .filter((f) => f.delete.mock.calls.length > 0)
    .map((f) => f.name)
    .sort();
}

async function build(bucket: ReturnType<typeof makeBucket>) {
  const moduleRef = await Test.createTestingModule({
    providers: [EminiplayerPruneService, { provide: STORAGE_BUCKET, useValue: bucket }],
  }).compile();
  return moduleRef.get(EminiplayerPruneService);
}

/** An uncommitted day: artifacts at rest, no manifest.json. */
const ORPHAN_DAY = [
  `${PREFIX}/03052026/03042026_ES_RECAP.md`,
  `${PREFIX}/03052026/03052026_ES_TP.md`,
  `${PREFIX}/03052026/03052026_ES_TP.pdf`,
];

/** A committed day: artifacts plus the manifest that vouches for them. */
const COMMITTED_DAY = [
  `${PREFIX}/07012026/06302026_ES_RECAP.md`,
  `${PREFIX}/07012026/07012026_ES_TP.md`,
  `${PREFIX}/07012026/07012026_ES_TP.pdf`,
  `${PREFIX}/07012026/manifest.json`,
];

describe('EminiplayerPruneService.prune', () => {
  it('reports an uncommitted day\'s artifacts without deleting anything by default', async () => {
    const bucket = makeBucket([...ORPHAN_DAY, ...COMMITTED_DAY]);
    const service = await build(bucket);

    const report = await service.prune({});

    expect(report.apply).toBe(false);
    expect(report.deleted).toBe(0);
    expect(report.prunedDays).toEqual([{ date: '03052026', files: ORPHAN_DAY.sort() }]);
    expect(deleted(bucket)).toEqual([]);
  });

  it('deletes an uncommitted day\'s artifacts when apply=true', async () => {
    const bucket = makeBucket([...ORPHAN_DAY, ...COMMITTED_DAY]);
    const service = await build(bucket);

    const report = await service.prune({ apply: true });

    expect(report.apply).toBe(true);
    expect(report.deleted).toBe(3);
    expect(deleted(bucket)).toEqual(ORPHAN_DAY.sort());
  });

  it('never touches a committed day, even with apply=true', async () => {
    const bucket = makeBucket(COMMITTED_DAY);
    const service = await build(bucket);

    const report = await service.prune({ apply: true });

    expect(report.prunedDays).toEqual([]);
    expect(deleted(bucket)).toEqual([]);
  });

  it('ignores an uncommitted day that has no artifacts to prune', async () => {
    const bucket = makeBucket([`${PREFIX}/03052026/`]);
    const service = await build(bucket);

    const report = await service.prune({ apply: true });

    expect(report.prunedDays).toEqual([]);
    expect(report.deleted).toBe(0);
  });

  it('prunes only days inside the requested range', async () => {
    const other = [`${PREFIX}/01262026/01232026_ES_RECAP.md`];
    const bucket = makeBucket([...ORPHAN_DAY, ...other]);
    const service = await build(bucket);

    const report = await service.prune({ from: '03012026', to: '03312026', apply: true });

    expect(report.prunedDays.map((d) => d.date)).toEqual(['03052026']);
    expect(deleted(bucket)).toEqual(ORPHAN_DAY.sort());
  });

  it('skips a folder whose name is not a real calendar date', async () => {
    const bucket = makeBucket([`${PREFIX}/13012026/13012026_ES_TP.pdf`]);
    const service = await build(bucket);

    const report = await service.prune({ apply: true });

    expect(report.prunedDays).toEqual([]);
    expect(deleted(bucket)).toEqual([]);
  });
});
