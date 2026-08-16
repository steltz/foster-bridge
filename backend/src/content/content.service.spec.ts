import { ContentService } from './content.service';
import { ConflictException, BadRequestException } from '@nestjs/common';

const ROOT_TRADER_MD = '---\nname: context-trader\nstyle: contextual\n---\nbody';
const CHILD_TRADER_MD = '---\nname: context-structured\norigin: context-trader\nmutation: adds structure\n---\nbody2';

function fakeDb() {
  const created: Record<string, any> = {};
  return {
    created,
    collection: (col: string) => ({
      doc: (id: string) => ({
        create: (data: any) => {
          const key = `${col}/${id}`;
          if (key in created) {
            const err: any = new Error('ALREADY_EXISTS');
            err.code = 6;
            return Promise.reject(err);
          }
          created[key] = data;
          return Promise.resolve();
        },
      }),
      get: () => Promise.resolve({ docs: Object.entries(created).filter(([k]) => k.startsWith(`${col}/`)).map(([, v]) => ({ data: () => v })) }),
    }),
  } as any;
}

function fakeBucket() {
  const saved: Record<string, string> = {};
  return {
    saved,
    file: (path: string) => ({
      save: (content: string) => { saved[path] = content; return Promise.resolve(); },
      download: () => Promise.resolve([Buffer.from(saved[path])] as [Buffer]),
    }),
    getFiles: ({ prefix }: { prefix: string }) =>
      Promise.resolve([Object.keys(saved).filter((n) => n.startsWith(prefix)).map((name) => ({ name }))]),
  } as any;
}

describe('ContentService', () => {
  it('createTrader accepts ROOT personas (no lineage) and children alike; write-once', async () => {
    const db = fakeDb();
    const svc = new ContentService(db, fakeBucket());
    const root = await svc.createTrader(ROOT_TRADER_MD);
    expect(root.name).toBe('context-trader');
    expect(db.created['traders/context-trader'].content).toBe(ROOT_TRADER_MD);
    const child = await svc.createTrader(CHILD_TRADER_MD);
    expect(child.name).toBe('context-structured');
    await expect(svc.createTrader(ROOT_TRADER_MD)).rejects.toThrow(ConflictException);
    await expect(svc.createTrader('no frontmatter at all')).rejects.toThrow(BadRequestException); // no name
    await expect(svc.createTrader('---\nname: bad/name\n---\nx')).rejects.toThrow(BadRequestException);
  });

  it('createFeature requires id frontmatter; write-once; no staticDocContent parameter exists', async () => {
    const svc = new ContentService(fakeDb(), fakeBucket());
    const md = '---\nid: seven-keys-method\nname: Seven Keys\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\nblock';
    const res = await svc.createFeature(md);
    expect(res.id).toBe('seven-keys-method');
    await expect(svc.createFeature(md)).rejects.toThrow(ConflictException);
    await expect(svc.createFeature('---\nname: no-id\n---\nx')).rejects.toThrow(BadRequestException);
  });

  it('putGeneral writes via generalDocPath and rejects path-escaping names', async () => {
    const bucket = fakeBucket();
    const svc = new ContentService(fakeDb(), bucket);
    const res = await svc.putGeneral('support_and_resistance_zones', 'ZONES');
    expect(res.path).toBe('knowledge-base/general/support_and_resistance_zones.md');
    expect(bucket.saved[res.path]).toBe('ZONES');
    await expect(svc.putGeneral('../evil', 'x')).rejects.toThrow(BadRequestException);
  });

  it('putMethods writes the fixed methods path', async () => {
    const bucket = fakeBucket();
    const svc = new ContentService(fakeDb(), bucket);
    const res = await svc.putMethods('METHODS');
    expect(res.path).toBe('knowledge-base/methods/seven-keys.md');
    expect(bucket.saved[res.path]).toBe('METHODS');
  });

  it('listGeneral returns path AND sha256 computed from content', async () => {
    const bucket = fakeBucket();
    const svc = new ContentService(fakeDb(), bucket);
    await svc.putGeneral('a', 'AAA');
    const listing = await svc.listGeneral();
    expect(listing).toEqual([{ path: 'knowledge-base/general/a.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });
});
