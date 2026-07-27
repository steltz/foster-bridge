import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RepoInputsService } from './repo-inputs.service';

let root: string;

function seedFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  mkdirSync(join(dir, 'traders'), { recursive: true });
  writeFileSync(join(dir, 'traders', 'context-trader.md'), '---\nname: context-trader\n---\nbody');
  writeFileSync(join(dir, 'traders', 'spawn.md'), '---\nname: spawn\norigin: context-trader\nmutation: tweak\n---\nbody');

  mkdirSync(join(dir, 'features'), { recursive: true });
  mkdirSync(join(dir, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'methods', 'seven-keys.md'), 'METHODS DOC');
  writeFileSync(
    join(dir, 'features', 'seven-keys-method.md'),
    '---\nid: seven-keys-method\nname: Seven-Keys methodology\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\nRead ${DOC}. Grade the zones.',
  );

  mkdirSync(join(dir, 'knowledge-base', 'general'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'general', 'a.md'), 'AAA');
  writeFileSync(join(dir, 'knowledge-base', 'general', 'b.md'), 'BBB');

  const day = join(dir, 'knowledge-base', 'es', '07012026');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, '07012026_ES_TP.pdf'), 'PDFBYTES');
  writeFileSync(join(day, '07012026_ES_TP.md'), 'PLAN');
  writeFileSync(join(day, '06302026_ES_RECAP.md'), 'RECAP');
  // Incomplete day (missing recap) must be skipped.
  const bad = join(dir, 'knowledge-base', 'es', '07022026');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, '07022026_ES_TP.pdf'), 'x');
  writeFileSync(join(bad, '07022026_ES_TP.md'), 'x');
  // All three docs present, but the TP.pdf and TP.md date prefixes disagree.
  const mismatch = join(dir, 'knowledge-base', 'es', '07032026');
  mkdirSync(mismatch, { recursive: true });
  writeFileSync(join(mismatch, '07032026_ES_TP.pdf'), 'x');
  writeFileSync(join(mismatch, '07042026_ES_TP.md'), 'x');
  writeFileSync(join(mismatch, '07032026_ES_RECAP.md'), 'x');
  return dir;
}

async function build(repoRoot: string) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RepoInputsService,
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'benchmark.repoRoot' ? repoRoot : undefined) } },
    ],
  }).compile();
  return moduleRef.get(RepoInputsService);
}

beforeAll(() => {
  root = seedFixture();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RepoInputsService', () => {
  it('sha256 hashes content', async () => {
    const svc = await build(root);
    expect(svc.sha256('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('collectTraders reads name/origin/mutation, content and hash, sorted by file', async () => {
    const svc = await build(root);
    const traders = svc.collectTraders();
    expect(traders.map((t) => t.name)).toEqual(['context-trader', 'spawn']);
    expect(traders[1].origin).toBe('context-trader');
    expect(traders[1].mutation).toBe('tweak');
    expect(traders[0].sha256).toBe(svc.sha256(traders[0].content));
  });

  it('collectFeatures reads id/name/staticDoc, extracts the block, and hashes file + staticDoc', async () => {
    const svc = await build(root);
    const [f] = svc.collectFeatures();
    expect(f.id).toBe('seven-keys-method');
    expect(f.name).toBe('Seven-Keys methodology');
    expect(f.staticDoc).toBe('knowledge-base/methods/seven-keys.md');
    expect(f.block).toBe('Read ${DOC}. Grade the zones.');
    expect(f.staticDocContent).toBe('METHODS DOC');
    expect(f.staticDocSha256).toBe(svc.sha256('METHODS DOC'));
  });

  it('collectGeneralDocs concatenates in sorted path order and hashes', async () => {
    const svc = await build(root);
    const g = svc.collectGeneralDocs();
    expect(g.concatenated).toBe('AAABBB');
    expect(g.sha256).toBe(svc.sha256('AAABBB'));
  });

  it('collectDays returns only complete folders with a derived YYYY-MM-DD date', async () => {
    const svc = await build(root);
    const days = svc.collectDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ day: '07012026', date: '2026-07-01', prefix: '07012026' });
    expect(days[0].pdfPath.endsWith('07012026_ES_TP.pdf')).toBe(true);
  });

  it('collectDays excludes a folder with all three docs when the TP.pdf/TP.md prefixes disagree', async () => {
    const svc = await build(root);
    const days = svc.collectDays();
    expect(days.some((d) => d.day === '07032026' || d.day === '07042026')).toBe(false);
  });

  it('collectDayIssues reports incomplete folders with the missing suffix(es)', async () => {
    const svc = await build(root);
    const issues = svc.collectDayIssues();
    // 07022026 is missing the recap doc; 07032026 has all three but mismatched prefixes.
    expect(issues).toEqual([
      { day: '07022026', missing: ['*_ES_RECAP.md'] },
      {
        day: '07032026',
        missing: ['prefix mismatch: *_ES_TP.pdf and *_ES_TP.md date prefixes differ or are not 8 digits'],
      },
    ]);
  });

  it('readMethodsDoc returns the methods content', async () => {
    const svc = await build(root);
    expect(svc.readMethodsDoc()).toBe('METHODS DOC');
  });
});
