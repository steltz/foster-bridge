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
  // Two recaps in one folder — a stale one left beside the real one. Which is
  // which is not knowable from the listing, so the day is unusable, not
  // silently resolved by readdir order.
  const ambiguous = join(dir, 'knowledge-base', 'es', '07102026');
  mkdirSync(ambiguous, { recursive: true });
  writeFileSync(join(ambiguous, '07102026_ES_TP.pdf'), 'x');
  writeFileSync(join(ambiguous, '07102026_ES_TP.md'), 'x');
  writeFileSync(join(ambiguous, '07052026_ES_RECAP.md'), 'STALE');
  writeFileSync(join(ambiguous, '07062026_ES_RECAP.md'), 'REAL');

  // Scorecard feature (carries an artifactSuffix the method feature lacks).
  writeFileSync(
    join(dir, 'features', 'seven-keys-scorecard.md'),
    '---\nid: seven-keys-scorecard\nname: Seven-Keys precomputed scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\n---\nRead ${DOC} then ${ARTIFACT}.',
  );
  // Two more complete days so priorCompleteDays has a chain. Recaps are named for
  // the PRIOR session and sit in the FOLLOWING day's folder.
  const d2 = join(dir, 'knowledge-base', 'es', '07082026');
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d2, '07082026_ES_TP.pdf'), 'x');
  writeFileSync(join(d2, '07082026_ES_TP.md'), 'x');
  writeFileSync(join(d2, '07012026_ES_RECAP.md'), 'OUTCOME-0701'); // outcome recap for 07012026
  const d3 = join(dir, 'knowledge-base', 'es', '07092026');
  mkdirSync(d3, { recursive: true });
  writeFileSync(join(d3, '07092026_ES_TP.pdf'), 'x');
  writeFileSync(join(d3, '07092026_ES_TP.md'), 'x');
  writeFileSync(join(d3, '07082026_ES_RECAP.md'), 'OUTCOME-0708'); // outcome recap for 07082026
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
    expect(days.map((d) => d.day)).toEqual(['07012026', '07082026', '07092026']);
    expect(days[0]).toMatchObject({ day: '07012026', date: '2026-07-01', prefix: '07012026' });
    expect(days[0].pdfPath.endsWith('07012026_ES_TP.pdf')).toBe(true);
  });

  it('collectDays excludes a folder with all three docs when the TP.pdf/TP.md prefixes disagree', async () => {
    const svc = await build(root);
    const days = svc.collectDays();
    expect(days.some((d) => d.day === '07032026' || d.day === '07042026')).toBe(false);
  });

  it('collectDays excludes a folder holding two recaps rather than picking one by readdir order', async () => {
    const svc = await build(root);
    expect(svc.collectDays().some((d) => d.day === '07102026')).toBe(false);
  });

  it('collectDayIssues reports incomplete folders with the missing suffix(es)', async () => {
    const svc = await build(root);
    const issues = svc.collectDayIssues();
    // 07022026 is missing the recap doc; 07032026 has all three but mismatched
    // prefixes; 07102026 has two recaps where exactly one is required.
    expect(issues).toEqual([
      { day: '07022026', missing: ['*_ES_RECAP.md'] },
      {
        day: '07032026',
        missing: ['prefix mismatch: *_ES_TP.pdf and *_ES_TP.md date prefixes differ or are not 8 digits'],
      },
      {
        day: '07102026',
        missing: ['ambiguous: 2 files match *_ES_RECAP.md — exactly one is required'],
      },
    ]);
  });

  it('readMethodsDoc returns the methods content', async () => {
    const svc = await build(root);
    expect(svc.readMethodsDoc()).toBe('METHODS DOC');
  });

  it('collectFeatures reads artifactSuffix (scorecard) and null for a method feature', async () => {
    const svc = await build(root);
    const byId = new Map(svc.collectFeatures().map((f) => [f.id, f]));
    expect(byId.get('seven-keys-scorecard')!.artifactSuffix).toBe('_ES_KEYS.md');
    expect(byId.get('seven-keys-method')!.artifactSuffix).toBeNull();
  });

  it('priorCompleteDays returns complete days strictly before the target, chronological', async () => {
    const svc = await build(root);
    expect(svc.priorCompleteDays('07092026').map((d) => d.day)).toEqual(['07012026', '07082026']);
    expect(svc.priorCompleteDays('07082026').map((d) => d.day)).toEqual(['07012026']);
    expect(svc.priorCompleteDays('07012026')).toEqual([]); // bootstrap
  });

  it('outcomeRecapPathForDay resolves the recap in the NEXT day folder, null when absent', async () => {
    const svc = await build(root);
    expect(svc.outcomeRecapPathForDay('07012026')!.endsWith('07082026/07012026_ES_RECAP.md')).toBe(true);
    expect(svc.outcomeRecapPathForDay('07082026')!.endsWith('07092026/07082026_ES_RECAP.md')).toBe(true);
    expect(svc.outcomeRecapPathForDay('07092026')).toBeNull(); // no 07102026 folder
  });
});
