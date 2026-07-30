import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DayArtifactsService } from './day-artifacts.service';
import { BenchmarkRepository } from './benchmark.repository';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { FIRESTORE } from '../firebase/firebase.constants';
import { fakeFirestore } from '../../test/fake-firestore';

function fakeBucket() {
  const saved: Record<string, Buffer> = {};
  const downloads: string[] = [];
  const saves: string[] = [];
  return {
    saved,
    downloads,
    saves,
    file: (path: string) => ({
      save: (buf: Buffer) => {
        saved[path] = buf;
        saves.push(path);
        return Promise.resolve();
      },
      exists: () => Promise.resolve([path in saved] as [boolean]),
      download: () => {
        downloads.push(path);
        return Promise.resolve([saved[path]] as [Buffer]);
      },
    }),
  };
}

// `provider` is what LLM_PROVIDER currently resolves to — undefined exercises the
// same 'anthropic' default LlmModule applies when llm.provider is unset.
async function build(provider?: string) {
  const bucket = fakeBucket();
  const upload = jest.fn().mockResolvedValue('file_new');
  const moduleRef = await Test.createTestingModule({
    providers: [
      DayArtifactsService,
      BenchmarkRepository,
      { provide: FIRESTORE, useValue: fakeFirestore() },
      { provide: STORAGE_BUCKET, useValue: bucket },
      { provide: LLM_PROVIDER, useValue: { uploadFile: upload } },
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'llm.provider' ? provider : undefined) } },
    ],
  }).compile();
  return { svc: moduleRef.get(DayArtifactsService), bucket, upload, repo: moduleRef.get(BenchmarkRepository) };
}

const PDF_PATH = 'benchmark/es/07012026/07012026_ES_TP.pdf';

describe('DayArtifactsService', () => {
  it('ensurePdf stores to GCS, uploads to Anthropic, and records the artifact', async () => {
    const { svc, bucket, upload, repo } = await build();
    const res = await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect(res.providerFileId).toBe('file_new');
    expect(res.gcsPath).toBe(PDF_PATH);
    expect(bucket.saved[PDF_PATH]).toBeDefined();
    expect(upload).toHaveBeenCalledTimes(1);
    expect((await repo.getDayArtifact('07012026', 'pdfFile'))?.providerFileId).toBe('file_new');
  });

  it('ensurePdf reuses the stored file_id when the content hash matches', async () => {
    const { svc, upload } = await build();
    await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    const again = await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect(again.providerFileId).toBe('file_new');
    expect(upload).toHaveBeenCalledTimes(1); // not re-uploaded
  });

  it('ensurePdf re-uploads from the GCS copy (not the passed bytes) when the file_id is gone (FIX 8)', async () => {
    const { svc, bucket, upload, repo } = await build();
    await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    // Simulate the provider file being GC'd: drop the stored id, keep the hash.
    const stored = await repo.getDayArtifact('07012026', 'pdfFile');
    await repo.saveDayArtifact('07012026', 'pdfFile', { ...stored!, providerFileId: undefined });
    upload.mockResolvedValueOnce('file_reup');
    const savesBefore = bucket.saves.length;
    const res = await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect(res.providerFileId).toBe('file_reup');
    expect(bucket.downloads).toContain(PDF_PATH); // read the durable origin
    expect(bucket.saves.length).toBe(savesBefore); // did NOT re-write GCS
    expect((await repo.getDayArtifact('07012026', 'pdfFile'))?.providerFileId).toBe('file_reup');
  });

  it('ensureFileId returns the stored id, or re-uploads from GCS when absent (FIX 8)', async () => {
    const { svc, bucket, upload, repo } = await build();
    await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect(await svc.ensureFileId('07012026')).toBe('file_new'); // live stored id
    const stored = await repo.getDayArtifact('07012026', 'pdfFile');
    await repo.saveDayArtifact('07012026', 'pdfFile', { ...stored!, providerFileId: undefined });
    upload.mockResolvedValueOnce('file_reup');
    expect(await svc.ensureFileId('07012026')).toBe('file_reup');
    expect(bucket.downloads).toContain(PDF_PATH);
  });

  it('reads a legacy anthropicFileId when providerFileId is absent', async () => {
    const { svc, repo, upload } = await build();
    await repo.saveDayArtifact('07012026', 'pdfFile', {
      contentHash: 'h',
      gcsPath: 'g',
      anthropicFileId: 'legacy_id',
      uploadedAt: 't',
    });
    const id = await svc.ensureFileId('07012026');
    expect(id).toBe('legacy_id');
    // Regression guard for the existing Anthropic fleet: an untagged legacy doc
    // read under Anthropic must NOT be mistaken for a foreign id and re-uploaded.
    expect(upload).not.toHaveBeenCalled();
  });

  it('re-uploads and re-tags when the stored id was minted by a different provider', async () => {
    // Every pre-existing day carries an Anthropic id with no fileProvider tag. Under
    // LLM_PROVIDER=moonshot, returning it would hand Moonshot a meaningless
    // `file_…` id -> every item of the day errors -> the reconciler writes nothing
    // -> the next run re-submits identically, forever (the re-upload path below only
    // fires on a MISSING id, so nothing ever self-heals).
    const { svc, bucket, upload, repo } = await build('moonshot');
    bucket.saved['g'] = Buffer.from('PDFBYTES');
    await repo.saveDayArtifact('07012026', 'pdfFile', {
      contentHash: 'h',
      gcsPath: 'g',
      providerFileId: 'file_anthropic',
      uploadedAt: 't',
    });
    upload.mockResolvedValueOnce('moonshot-extract:abc');
    expect(await svc.ensureFileId('07012026')).toBe('moonshot-extract:abc');
    expect(bucket.downloads).toContain('g'); // re-uploaded from the durable origin
    const stored = await repo.getDayArtifact('07012026', 'pdfFile');
    expect(stored?.providerFileId).toBe('moonshot-extract:abc');
    expect(stored?.fileProvider).toBe('moonshot'); // tagged, so the next read short-circuits
  });

  it('short-circuits a stored id that the active provider minted', async () => {
    const { svc, upload, repo } = await build('moonshot');
    await repo.saveDayArtifact('07012026', 'pdfFile', {
      contentHash: 'h',
      gcsPath: 'g',
      providerFileId: 'moonshot-extract:abc',
      fileProvider: 'moonshot',
      uploadedAt: 't',
    });
    expect(await svc.ensureFileId('07012026')).toBe('moonshot-extract:abc');
    expect(upload).not.toHaveBeenCalled();
  });

  it('ensurePdf re-uploads on a provider mismatch without re-writing GCS', async () => {
    const { svc, bucket, upload, repo } = await build('moonshot');
    bucket.saved[PDF_PATH] = Buffer.from('PDFBYTES');
    await repo.saveDayArtifact('07012026', 'pdfFile', {
      contentHash: createHash('sha256').update('PDFBYTES').digest('hex'), // hash MATCHES -> reuse arm
      gcsPath: PDF_PATH,
      providerFileId: 'file_anthropic',
      uploadedAt: 't',
    });
    const savesBefore = bucket.saves.length;
    upload.mockResolvedValueOnce('moonshot-extract:abc');
    const res = await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect(res.providerFileId).toBe('moonshot-extract:abc');
    expect(bucket.downloads).toContain(PDF_PATH);
    expect(bucket.saves.length).toBe(savesBefore); // content is unchanged — GCS untouched
    expect((await repo.getDayArtifact('07012026', 'pdfFile'))?.fileProvider).toBe('moonshot');
  });

  it('tags a fresh upload with the active provider', async () => {
    const { svc, repo } = await build('moonshot');
    await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect((await repo.getDayArtifact('07012026', 'pdfFile'))?.fileProvider).toBe('moonshot');
  });

  it('prefers providerFileId over a legacy anthropicFileId when both are present', async () => {
    const { svc, repo } = await build();
    await repo.saveDayArtifact('07012026', 'pdfFile', {
      contentHash: 'h',
      gcsPath: 'g',
      providerFileId: 'new_id',
      anthropicFileId: 'legacy_id',
      uploadedAt: 't',
    });
    const id = await svc.ensureFileId('07012026');
    expect(id).toBe('new_id');
  });

  it('ensureTranscript mirrors text to GCS and records it', async () => {
    const { svc, bucket, repo } = await build();
    await svc.ensureTranscript('07012026', 'tpTranscript', '07012026_ES_TP.md', 'PLAN TEXT');
    expect(bucket.saved['benchmark/es/07012026/07012026_ES_TP.md']).toBeDefined();
    expect((await repo.getDayArtifact('07012026', 'tpTranscript'))?.content).toBe('PLAN TEXT');
  });
});
