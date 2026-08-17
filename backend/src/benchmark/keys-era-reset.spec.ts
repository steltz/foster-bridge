import { planKeysEraReset } from './keys-era-reset';

const artifacts = [
  { id: '01062025__keys__k3', contentHash: 'h-k3-a' },
  { id: '08032026__keys__k3', contentHash: 'h-k3-b' },
  { id: '08032026__pdfFile', contentHash: 'h-pdf' },
  { id: '07012026__keys__fable', contentHash: 'h-fable' },
  { id: '05052025__keys', contentHash: 'h-legacy-k3', generatedBy: 'kimi-k3' },
  { id: '05062025__keys', contentHash: 'h-legacy-fable', generatedBy: 'claude-fable-5' },
];

describe('planKeysEraReset', () => {
  it("deletes this lineage's scoped artifacts and its legacy unscoped docs only", () => {
    const plan = planKeysEraReset(artifacts, [], 'k3');
    expect(plan.artifactIdsToDelete).toEqual(['01062025__keys__k3', '08032026__keys__k3', '05052025__keys']);
  });

  it('deletes only cells pinning a hash of a deleted artifact', () => {
    const cells = [
      { id: 'c-k3-a', artifactSha256: 'h-k3-a' },
      { id: 'c-fable', artifactSha256: 'h-fable' },
      { id: 'c-base', artifactSha256: null },
      { id: 'c-method' },
      { id: 'c-legacy', artifactSha256: 'h-legacy-k3' },
    ];
    const plan = planKeysEraReset(artifacts, cells, 'k3');
    expect(plan.cellIdsToDelete).toEqual(['c-k3-a', 'c-legacy']);
    expect(plan.keptCellCount).toBe(3); // fable + base + method survive
  });

  it('is a no-op on an already-clean era', () => {
    const plan = planKeysEraReset([{ id: '08032026__pdfFile' }], [{ id: 'c1' }], 'k3');
    expect(plan).toEqual({ artifactIdsToDelete: [], cellIdsToDelete: [], keptCellCount: 1 });
  });
});
