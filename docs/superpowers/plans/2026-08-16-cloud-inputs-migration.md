# Cloud Inputs Migration Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the benchmark's local-filesystem input layer with a snapshot-based `CloudInputsService` (Firebase Storage + Firestore), add validated write endpoints, wipe the skills-era benchmark data, and migrate content into the cloud stores — a clean-slate era with nothing local.

**Architecture:** `CloudInputsService` exposes one `snapshot()` that fetches every input (traders/features from Firestore; general docs, methods doc, and manifest-committed day listings from the bucket) in a single concurrent pass; a benchmark run takes one snapshot and threads it down. `loadDay` verifies artifact sha256s against manifest FileRecords. The methods doc has one copy (bucket); features resolve it live. A new `ContentModule` exposes write-once persona/feature endpoints and mutable knowledge-doc PUTs. The old era's four Firestore collections are wiped before the first new run.

**Tech Stack:** NestJS 10, firebase-admin (Firestore + Storage), Jest. Package manager: `pnpm`, run from `backend/`.

**Spec:** `docs/superpowers/specs/2026-08-16-cloud-inputs-migration-design.md` (v2)

## Global Constraints

- All commands run from `/Users/nicholasstelter/Code/foster-bridge/backend` unless stated otherwise.
- Test commands: `pnpm test -- --runTestsByPath <path>` (unit), `pnpm test:e2e -- --runTestsByPath <path>` (e2e).
- **Clean slate:** no backward compatibility with skills-era cells/hashes/persona versions. The four collections `benchmarkRuns`, `benchmarkBatches`, `benchmarkScoreboard`, `dayArtifacts` are wiped in Task 8 before the first new run.
- Hashing scheme (internal consistency, not legacy compat): persona/feature sha256 = sha256 of full markdown; `staticDocSha256` = sha256 of the resolved methods doc; general sha256 = sha256 of path-sorted concatenation, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` when empty.
- The drift guard keeps its no-bypass semantics. Do not add any bypass flag.
- Day-doc storage paths come from `src/eminiplayer/eminiplayer-validation.ts` (`ES_STORAGE_PREFIX`, `dayPaths`, `manifestPath`) — never hand-build them, including in regexes. The new `GENERAL_PREFIX`/`generalDocPath`/`METHODS_PATH` constants live ONLY in `cloud-inputs.service.ts`; `content.service.ts` imports them.
- Firestore content collections: `traders` (doc id = name), `features` (doc id = id), write-once via `create()`, content-canonical (derived fields parsed from `content` at read time, sha recomputed at read time).
- Semantic commit messages; no Claude attributions in commits or PRs.

---

### Task 1: Shared frontmatter helpers + CloudInputsService (Firestore half)

**Files:**
- Create: `src/common/markdown-frontmatter.ts`
- Create: `src/benchmark/cloud-inputs.service.ts`
- Create: `src/benchmark/cloud-inputs.service.spec.ts`

**Interfaces:**
- Consumes: `FIRESTORE`, `STORAGE_BUCKET` from `src/firebase/firebase.constants.ts`.
- Produces (exact exports later tasks rely on):
  - From `markdown-frontmatter.ts`: `parseFrontmatter(text: string): Record<string, string>`, `extractBlock(text: string): string` (ported verbatim from `repo-inputs.service.ts:63-91`).
  - From `cloud-inputs.service.ts`: `TRADERS_COLLECTION = 'traders'`, `FEATURES_COLLECTION = 'features'`, `GENERAL_PREFIX = 'knowledge-base/general/'`, `generalDocPath(name: string): string`, `METHODS_PATH = 'knowledge-base/methods/seven-keys.md'`; interfaces `TraderInput`, `FeatureInput`, `GeneralDocs`, `DayListing`, `DayInput`, `DayIssue`, `InputsSnapshot` (shapes exactly as the spec's CloudInputsService section); `class CloudInputsService` with `sha256(content: string): string`, `collectTraders(): Promise<TraderInput[]>`, `collectFeatures(methodsDoc: string | null): Promise<FeatureInput[]>`.

- [ ] **Step 1: Create the helpers file** (copy the two private functions out of `RepoInputsService` unchanged; do not edit `repo-inputs.service.ts` yet):

```ts
// src/common/markdown-frontmatter.ts
/** Frontmatter parser ported verbatim from src/lineage.js parseFrontmatter. */
export function parseFrontmatter(text: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const colon = line.indexOf(':');
    if (colon === -1 || /^\s/.test(line)) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

/** Body after the frontmatter block; ported from src/features.js extractBlock. */
export function extractBlock(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text.trim();
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return text.trim();
  return lines.slice(closeIndex + 1).join('\n').trim();
}
```

- [ ] **Step 2: Write failing specs for the Firestore half.** Note the root-persona case (no lineage) and the malformed-doc case — both are review findings turned tests.

```ts
// src/benchmark/cloud-inputs.service.spec.ts
import { CloudInputsService } from './cloud-inputs.service';

const ROOT_TRADER_MD = '---\nname: context-trader\nstyle: contextual\n---\nbody';
const CHILD_TRADER_MD = '---\nname: context-structured\norigin: context-trader\nmutation: adds structure\n---\nbody2';
const FEATURE_MD = '---\nid: seven-keys-scorecard\nname: Seven Keys Scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\n---\nblock text';
const PLAIN_FEATURE_MD = '---\nid: plain\nname: Plain\n---\nplain block';

function fakeDb(collections: Record<string, any[]>) {
  return {
    collection: (name: string) => ({
      get: () =>
        Promise.resolve({ docs: (collections[name] ?? []).map((data) => ({ data: () => data })) }),
    }),
  } as any;
}

function fakeBucket(objects: Record<string, string | Buffer> = {}) {
  return {
    getFiles: ({ prefix }: { prefix: string }) =>
      Promise.resolve([
        Object.keys(objects)
          .filter((n) => n.startsWith(prefix))
          .map((name) => ({ name })),
      ]),
    file: (path: string) => ({
      exists: () => Promise.resolve([path in objects] as [boolean]),
      download: () =>
        path in objects
          ? Promise.resolve([Buffer.from(objects[path])] as [Buffer])
          : Promise.reject(new Error(`No such object: ${path}`)),
    }),
  } as any;
}

describe('CloudInputsService (firestore half)', () => {
  it('collectTraders maps docs, accepts root personas without lineage, recomputes sha256, sorts by name', async () => {
    const svc = new CloudInputsService(
      fakeDb({ traders: [
        { name: 'context-trader', content: ROOT_TRADER_MD, sha256: 'stale-ignored' },
        { name: 'context-structured', content: CHILD_TRADER_MD, sha256: 'stale-ignored' },
      ] }),
      fakeBucket(),
    );
    const traders = await svc.collectTraders();
    expect(traders.map((t) => t.name)).toEqual(['context-structured', 'context-trader']);
    const root = traders.find((t) => t.name === 'context-trader')!;
    expect(root).toMatchObject({ origin: null, mutation: null, content: ROOT_TRADER_MD });
    expect(root.sha256).toBe(svc.sha256(ROOT_TRADER_MD)); // recomputed, never trusted
    const child = traders.find((t) => t.name === 'context-structured')!;
    expect(child).toMatchObject({ origin: 'context-trader', mutation: 'adds structure' });
  });

  it('collectFeatures resolves staticDocContent from the passed methods doc only when frontmatter has staticDoc', async () => {
    const svc = new CloudInputsService(
      fakeDb({ features: [
        { id: 'seven-keys-scorecard', content: FEATURE_MD },
        { id: 'plain', content: PLAIN_FEATURE_MD },
      ] }),
      fakeBucket(),
    );
    const features = await svc.collectFeatures('METHODS DOC');
    expect(features.map((f) => f.id)).toEqual(['plain', 'seven-keys-scorecard']);
    const scorecard = features.find((f) => f.id === 'seven-keys-scorecard')!;
    expect(scorecard).toMatchObject({
      name: 'Seven Keys Scorecard',
      block: 'block text',
      artifactSuffix: '_ES_KEYS.md',
      staticDocContent: 'METHODS DOC',
    });
    expect(scorecard.sha256).toBe(svc.sha256(FEATURE_MD));
    expect(scorecard.staticDocSha256).toBe(svc.sha256('METHODS DOC'));
    const plain = features.find((f) => f.id === 'plain')!;
    expect(plain.staticDocContent).toBeNull();
    expect(plain.staticDocSha256).toBeNull();
  });

  it('a feature with staticDoc but a null methods doc yields null staticDocContent (surfaced by run-time refusals, not a crash)', async () => {
    const svc = new CloudInputsService(fakeDb({ features: [{ id: 'seven-keys-scorecard', content: FEATURE_MD }] }), fakeBucket());
    const [f] = await svc.collectFeatures(null);
    expect(f.staticDocContent).toBeNull();
  });

  it('empty collections return []', async () => {
    const svc = new CloudInputsService(fakeDb({}), fakeBucket());
    expect(await svc.collectTraders()).toEqual([]);
    expect(await svc.collectFeatures(null)).toEqual([]);
  });

  it('a malformed doc (missing content) produces a NAMED error, not a TypeError', async () => {
    const svc = new CloudInputsService(fakeDb({ traders: [{ name: 'broken' }] }), fakeBucket());
    await expect(svc.collectTraders()).rejects.toThrow(/traders\/broken is malformed/);
  });

  it('wraps a rejecting firestore read in ServiceUnavailableException', async () => {
    const db = { collection: () => ({ get: () => Promise.reject(new Error('UNAVAILABLE')) }) } as any;
    const svc = new CloudInputsService(db, fakeBucket());
    await expect(svc.collectTraders()).rejects.toThrow('inputs unavailable');
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/cloud-inputs.service.spec.ts` — expected: FAIL, cannot find module `./cloud-inputs.service`.

- [ ] **Step 4: Implement the Firestore half**

```ts
// src/benchmark/cloud-inputs.service.ts
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { parseFrontmatter, extractBlock } from '../common/markdown-frontmatter';

const ZERO_BYTES_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const TRADERS_COLLECTION = 'traders';
export const FEATURES_COLLECTION = 'features';

// ---- single home of the general/methods storage contract (spec: a second
// definition anywhere is a defect; content.service.ts imports these) ----
export const GENERAL_PREFIX = 'knowledge-base/general/';
export function generalDocPath(name: string): string {
  return `${GENERAL_PREFIX}${name}.md`;
}
export const METHODS_PATH = 'knowledge-base/methods/seven-keys.md';

export interface TraderInput {
  name: string;
  origin: string | null; // null for root personas — no lineage required
  mutation: string | null;
  content: string;
  sha256: string;
}
export interface FeatureInput {
  id: string;
  name: string;
  block: string;
  sha256: string;
  staticDocContent: string | null; // resolved live from the bucket methods doc
  staticDocSha256: string | null;
  artifactSuffix: string | null;
}
export interface GeneralDocs {
  files: { path: string; content: string }[];
  concatenated: string;
  sha256: string;
}
export interface DayListing {
  day: string; // MMDDYYYY
  date: string; // YYYY-MM-DD
  prefix: string; // TP filename prefix (== day in the bucket layout)
  recapDate: string;
  /** Manifest FileRecord hashes — loadDay verifies downloads against these. */
  fileSha256: { tradePlanMd: string; tradePlanPdf: string; recap: string };
}
export interface DayInput extends DayListing {
  pdf: Buffer;
  tpTranscript: string;
  recapTranscript: string;
  recapFileName: string; // `${recapDate}_ES_RECAP.md`
}
export interface DayIssue {
  day: string;
  missing: string[];
}
export interface InputsSnapshot {
  traders: TraderInput[];
  features: FeatureInput[];
  general: GeneralDocs;
  methodsDoc: string | null;
  days: DayListing[];
  issues: DayIssue[];
}

/** Minimal bucket surface so specs can fake it (mirrors day-artifacts.service.ts). */
export interface InputsBucketLike {
  file(path: string): {
    exists(): Promise<[boolean]>;
    download(): Promise<[Buffer]>;
  };
  getFiles(opts: { prefix: string }): Promise<[{ name: string }[]]>;
}

@Injectable()
export class CloudInputsService {
  constructor(
    @Inject(FIRESTORE) private readonly db: Firestore,
    @Inject(STORAGE_BUCKET) private readonly bucket: InputsBucketLike,
  ) {}

  sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // Fail-closed for the run-start snapshot: an unreachable input store must
  // abort as a 503 before anything is uploaded or submitted. (Once batches
  // start submitting, loadDay failures fall to per-day isolation instead —
  // this wrap's promise is scoped to the up-front fetches.)
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(`inputs unavailable: ${(err as Error).message}`);
    }
  }

  async collectTraders(): Promise<TraderInput[]> {
    const snap = await this.wrap(() => this.db.collection(TRADERS_COLLECTION).get());
    return snap.docs
      .map((d) => {
        const doc = d.data() as { name?: string; content?: string };
        // Malformed docs are only possible via out-of-band writes; name them
        // instead of letting sort()/parse throw a bare TypeError.
        if (typeof doc.name !== 'string' || typeof doc.content !== 'string') {
          throw new ServiceUnavailableException(`traders/${doc.name ?? '<unnamed>'} is malformed (missing name or content)`);
        }
        return doc as { name: string; content: string };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((doc) => {
        const fm = parseFrontmatter(doc.content);
        return {
          name: doc.name,
          origin: fm.origin || null,
          mutation: fm.mutation || null,
          content: doc.content,
          // Recomputed from content (never trusted from the stored doc) so an
          // out-of-band Firestore edit is visible to the drift guard.
          sha256: this.sha256(doc.content),
        };
      });
  }

  /**
   * methodsDoc is passed in (fetched once by snapshot()) and resolved into any
   * feature whose frontmatter carries a staticDoc key — the methods doc has
   * ONE copy, in the bucket, and prompts/drift both read these same bytes.
   */
  async collectFeatures(methodsDoc: string | null): Promise<FeatureInput[]> {
    const snap = await this.wrap(() => this.db.collection(FEATURES_COLLECTION).get());
    return snap.docs
      .map((d) => {
        const doc = d.data() as { id?: string; content?: string };
        if (typeof doc.id !== 'string' || typeof doc.content !== 'string') {
          throw new ServiceUnavailableException(`features/${doc.id ?? '<unnamed>'} is malformed (missing id or content)`);
        }
        return doc as { id: string; content: string };
      })
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => {
        const fm = parseFrontmatter(doc.content);
        const staticDocContent = fm.staticDoc ? methodsDoc : null;
        return {
          id: doc.id,
          name: fm.name || doc.id,
          block: extractBlock(doc.content),
          sha256: this.sha256(doc.content),
          staticDocContent,
          staticDocSha256: staticDocContent !== null ? this.sha256(staticDocContent) : null,
          artifactSuffix: fm.artifactSuffix || null,
        };
      });
  }
}
```

- [ ] **Step 5: Run to verify pass** — `pnpm test -- --runTestsByPath src/benchmark/cloud-inputs.service.spec.ts` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/common/markdown-frontmatter.ts src/benchmark/cloud-inputs.service.ts src/benchmark/cloud-inputs.service.spec.ts
git commit -m "feat(benchmark): CloudInputsService firestore half (traders, features, live methods resolution)"
```

---

### Task 2: CloudInputsService — bucket half + snapshot

**Files:**
- Modify: `src/benchmark/cloud-inputs.service.ts`
- Modify: `src/benchmark/cloud-inputs.service.spec.ts`

**Interfaces:**
- Consumes: `ES_STORAGE_PREFIX`, `dayPaths(date, recapDate)`, `manifestPath(date)` from `src/eminiplayer/eminiplayer-validation.ts`; `DayManifest`'s `files.{tradePlanMd,tradePlanPdf,recap}.sha256` FileRecords from `src/eminiplayer/eminiplayer-manifest.service.ts`.
- Produces (exact methods later tasks call):
  - `snapshot(): Promise<InputsSnapshot>` — the single per-run fetch
  - `loadDay(listing: DayListing): Promise<DayInput>` — sha256-verified downloads
  - `outcomeRecapForDay(day: string, snap: InputsSnapshot): Promise<string | null>`
  - `priorCompleteDays(targetDay: string, snap: InputsSnapshot): DayListing[]` — pure, no I/O

- [ ] **Step 1: Add failing specs**

```ts
// append to src/benchmark/cloud-inputs.service.spec.ts
import { createHash } from 'node:crypto';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const manifest = (date: string, recapDate: string, files: { tp: string; pdf: string; recap: string }) =>
  JSON.stringify({
    date,
    recapDate,
    files: {
      tradePlanMd: { sha256: sha(files.tp) },
      tradePlanPdf: { sha256: sha(files.pdf) },
      recap: { sha256: sha(files.recap) },
    },
  });

function seededBucket() {
  return fakeBucket({
    'knowledge-base/general/a.md': 'AAA',
    'knowledge-base/general/b.md': 'BBB',
    'knowledge-base/methods/seven-keys.md': 'METHODS',
    'knowledge-base/es/07012026/manifest.json': manifest('07012026', '06302026', { tp: 'PLAN1', pdf: 'PDF1', recap: 'RECAP0630' }),
    'knowledge-base/es/07012026/07012026_ES_TP.md': 'PLAN1',
    'knowledge-base/es/07012026/07012026_ES_TP.pdf': 'PDF1',
    'knowledge-base/es/07012026/06302026_ES_RECAP.md': 'RECAP0630',
    'knowledge-base/es/07022026/manifest.json': manifest('07022026', '07012026', { tp: 'PLAN2', pdf: 'PDF2', recap: 'RECAP0701' }),
    'knowledge-base/es/07022026/07022026_ES_TP.md': 'PLAN2',
    'knowledge-base/es/07022026/07022026_ES_TP.pdf': 'PDF2',
    'knowledge-base/es/07022026/07012026_ES_RECAP.md': 'RECAP0701',
    // committed manifest but missing artifacts -> issue, not a day
    'knowledge-base/es/07062026/manifest.json': manifest('07062026', '07022026', { tp: 'PLAN3', pdf: 'PDF3', recap: 'RECAP0702' }),
    'knowledge-base/es/07062026/07062026_ES_TP.md': 'PLAN3',
    // an ORPHAN recap in an uncommitted folder — must NOT satisfy outcomeRecapForDay
    'knowledge-base/es/07072026/07022026_ES_RECAP.md': 'ORPHAN RECAP',
  });
}

describe('CloudInputsService (bucket half + snapshot)', () => {
  const build = (bucket = seededBucket()) =>
    new CloudInputsService(
      fakeDb({
        traders: [{ name: 'context-trader', content: ROOT_TRADER_MD }],
        features: [{ id: 'seven-keys-scorecard', content: FEATURE_MD }],
      }),
      bucket,
    );

  it('snapshot() assembles everything in one call; features carry the live methods doc', async () => {
    const snap = await build().snapshot();
    expect(snap.general.concatenated).toBe('AAABBB');
    expect(snap.methodsDoc).toBe('METHODS');
    expect(snap.traders).toHaveLength(1);
    expect(snap.features[0].staticDocContent).toBe('METHODS');
    expect(snap.days.map((d) => d.day)).toEqual(['07012026', '07022026']);
    expect(snap.days[0]).toMatchObject({ date: '2026-07-01', prefix: '07012026', recapDate: '06302026' });
    expect(snap.days[0].fileSha256.tradePlanMd).toBe(sha('PLAN1'));
    expect(snap.issues).toEqual([
      { day: '07062026', missing: expect.arrayContaining([expect.stringContaining('_ES_TP.pdf'), expect.stringContaining('_ES_RECAP.md')]) },
    ]);
  });

  it('empty general prefix hashes to the zero sentinel; missing methods doc is null', async () => {
    const snap = await new CloudInputsService(fakeDb({}), fakeBucket()).snapshot();
    expect(snap.general.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(snap.methodsDoc).toBeNull();
    expect(snap.days).toEqual([]);
  });

  it('loadDay downloads and VERIFIES all three artifacts against the manifest hashes', async () => {
    const svc = build();
    const snap = await svc.snapshot();
    const day = await svc.loadDay(snap.days[0]);
    expect(day.pdf.toString()).toBe('PDF1');
    expect(day.tpTranscript).toBe('PLAN1');
    expect(day.recapTranscript).toBe('RECAP0630');
    expect(day.recapFileName).toBe('06302026_ES_RECAP.md');
  });

  it('loadDay throws when an artifact no longer matches its manifest hash (force-rerun mid-run)', async () => {
    const bucket = seededBucket();
    const svc = build(bucket);
    const snap = await svc.snapshot();
    // simulate an eminiplayer force-rerun overwriting the plan after the snapshot
    (bucket as any).objects; // fakeBucket keeps objects internal — mutate via a fresh bucket instead:
    const tampered = fakeBucket({
      ...Object.fromEntries([['knowledge-base/es/07012026/07012026_ES_TP.md', 'TAMPERED PLAN']]),
      'knowledge-base/es/07012026/07012026_ES_TP.pdf': 'PDF1',
      'knowledge-base/es/07012026/06302026_ES_RECAP.md': 'RECAP0630',
    });
    const svc2 = new CloudInputsService(fakeDb({}), tampered);
    await expect(svc2.loadDay(snap.days[0])).rejects.toThrow(/07012026 changed/);
  });

  it('priorCompleteDays is a pure filter over the snapshot', async () => {
    const svc = build();
    const snap = await svc.snapshot();
    expect(svc.priorCompleteDays('07022026', snap).map((d) => d.day)).toEqual(['07012026']);
  });

  it('outcomeRecapForDay resolves through committed listings only — orphan folders never satisfy it', async () => {
    const svc = build();
    const snap = await svc.snapshot();
    expect(await svc.outcomeRecapForDay('07012026', snap)).toBe('RECAP0701'); // via committed 07022026
    // 07022026's outcome recap exists ONLY in the uncommitted 07072026 folder -> null
    expect(await svc.outcomeRecapForDay('07022026', snap)).toBeNull();
  });
});
```

(In the tamper test, note the second service reuses the FIRST snapshot's listing — that is the point: the listing's hashes are the contract the download must still satisfy.)

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/cloud-inputs.service.spec.ts` — expected: new describe FAILs.

- [ ] **Step 3: Implement.** Add imports `ES_STORAGE_PREFIX, dayPaths, manifestPath` from `../eminiplayer/eminiplayer-validation`, then append to the class:

```ts
  private async download(path: string): Promise<Buffer> {
    const [buf] = await this.bucket.file(path).download();
    return buf;
  }

  private async collectGeneralDocs(): Promise<GeneralDocs> {
    const [objects] = await this.bucket.getFiles({ prefix: GENERAL_PREFIX });
    const paths = objects.map((o) => o.name).filter((n) => !n.endsWith('/')).sort();
    const files = await Promise.all(
      paths.map(async (path) => ({ path, content: (await this.download(path)).toString('utf8') })),
    );
    const concatenated = files.map((f) => f.content).join('');
    return { files, concatenated, sha256: concatenated ? this.sha256(concatenated) : ZERO_BYTES_SHA256 };
  }

  private async readMethodsDoc(): Promise<string | null> {
    const [exists] = await this.bucket.file(METHODS_PATH).exists();
    if (!exists) return null;
    return (await this.download(METHODS_PATH)).toString('utf8');
  }

  // One list over the ES prefix; manifests download in PARALLEL. The matcher is
  // built from manifestPath() so a prefix change can never silently zero the
  // corpus (Global Constraint: no hand-built day paths, regexes included).
  private async scanDays(): Promise<{ listings: DayListing[]; issues: DayIssue[] }> {
    const [objects] = await this.bucket.getFiles({ prefix: ES_STORAGE_PREFIX });
    const names = new Set(objects.map((o) => o.name));
    const dayFolders = [...names]
      .map((n) => {
        const rest = n.slice(ES_STORAGE_PREFIX.length);
        const day = rest.split('/')[0];
        return /^\d{8}$/.test(day) && n === manifestPath(day) ? day : null;
      })
      .filter((d): d is string => d !== null);

    const listings: DayListing[] = [];
    const issues: DayIssue[] = [];
    await Promise.all(
      dayFolders.map(async (day) => {
        let recapDate: string;
        let fileSha256: DayListing['fileSha256'];
        try {
          const m = JSON.parse((await this.download(manifestPath(day))).toString('utf8')) as {
            recapDate: string;
            files: { tradePlanMd: { sha256: string }; tradePlanPdf: { sha256: string }; recap: { sha256: string } };
          };
          recapDate = m.recapDate;
          if (!/^\d{8}$/.test(recapDate)) throw new Error(`bad recapDate ${recapDate}`);
          fileSha256 = {
            tradePlanMd: m.files.tradePlanMd.sha256,
            tradePlanPdf: m.files.tradePlanPdf.sha256,
            recap: m.files.recap.sha256,
          };
        } catch (err) {
          issues.push({ day, missing: [`unreadable manifest: ${(err as Error).message}`] });
          return;
        }
        const paths = dayPaths(day, recapDate);
        const missing = [paths.tradePlanMd, paths.tradePlanPdf, paths.recap].filter((p) => !names.has(p));
        if (missing.length) {
          issues.push({ day, missing });
          return;
        }
        listings.push({
          day,
          date: `${day.slice(4, 8)}-${day.slice(0, 2)}-${day.slice(2, 4)}`,
          prefix: day,
          recapDate,
          fileSha256,
        });
      }),
    );
    listings.sort((a, b) => a.date.localeCompare(b.date));
    issues.sort((a, b) => a.day.localeCompare(b.day));
    return { listings, issues };
  }

  /** The single per-run fetch: everything concurrent, one bucket list. */
  async snapshot(): Promise<InputsSnapshot> {
    return this.wrap(async () => {
      const [traders, general, methodsDoc, scan] = await Promise.all([
        this.collectTraders(),
        this.collectGeneralDocs(),
        this.readMethodsDoc(),
        this.scanDays(),
      ]);
      const features = await this.collectFeatures(methodsDoc);
      return { traders, features, general, methodsDoc, days: scan.listings, issues: scan.issues };
    });
  }

  /**
   * Downloads the three artifacts and verifies each against the manifest
   * FileRecord hashes captured in the listing. A mismatch means an eminiplayer
   * force-rerun overwrote the day after the snapshot — throw so the run's
   * per-day isolation records a daysSkipped instead of freezing torn inputs
   * into cell provenance.
   */
  async loadDay(listing: DayListing): Promise<DayInput> {
    const paths = dayPaths(listing.day, listing.recapDate);
    const [pdf, tp, recap] = await Promise.all([
      this.download(paths.tradePlanPdf),
      this.download(paths.tradePlanMd),
      this.download(paths.recap),
    ]);
    const mismatches = [
      ['tradePlanPdf', this.sha256Bytes(pdf), listing.fileSha256.tradePlanPdf],
      ['tradePlanMd', this.sha256Bytes(tp), listing.fileSha256.tradePlanMd],
      ['recap', this.sha256Bytes(recap), listing.fileSha256.recap],
    ].filter(([, actual, expected]) => actual !== expected);
    if (mismatches.length) {
      throw new Error(
        `day ${listing.day} changed since the run snapshot (${mismatches.map(([k]) => k).join(', ')} no longer match the manifest) — likely a force-rerun; skip and re-run`,
      );
    }
    return {
      ...listing,
      pdf,
      tpTranscript: tp.toString('utf8'),
      recapTranscript: recap.toString('utf8'),
      recapFileName: `${listing.recapDate}_ES_RECAP.md`,
    };
  }

  private sha256Bytes(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  /** Pure filter — no I/O; days come from the run's snapshot. */
  priorCompleteDays(targetDay: string, snap: InputsSnapshot): DayListing[] {
    const targetDate = `${targetDay.slice(4, 8)}-${targetDay.slice(0, 2)}-${targetDay.slice(2, 4)}`;
    return snap.days.filter((d) => d.date < targetDate);
  }

  /**
   * A day's OUTCOME recap is `<day>_ES_RECAP.md` in the FOLLOWING day's folder.
   * Resolved through COMMITTED listings only (the listing whose recapDate is
   * this day), sha-verified — an orphan recap in an uncommitted folder never
   * satisfies this (spec deliberate choice 1).
   */
  async outcomeRecapForDay(day: string, snap: InputsSnapshot): Promise<string | null> {
    const host = snap.days.find((d) => d.recapDate === day);
    if (!host) return null;
    const buf = await this.download(dayPaths(host.day, day).recap);
    if (this.sha256Bytes(buf) !== host.fileSha256.recap) {
      throw new Error(`outcome recap for ${day} changed since the run snapshot — likely a force-rerun`);
    }
    return buf.toString('utf8');
  }
```

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/benchmark/cloud-inputs.service.spec.ts` — expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/cloud-inputs.service.ts src/benchmark/cloud-inputs.service.spec.ts
git commit -m "feat(benchmark): snapshot-based bucket half with manifest-verified day loads"
```

---

### Task 3: Drift findings gain a `source` field

**Files:**
- Modify: `src/benchmark/drift.ts`
- Modify: `src/benchmark/drift.spec.ts` (exists — extend)

**Interfaces:**
- Produces: `DriftFinding.source: 'firestore' | 'bucket'` — `'bucket'` for family `general`, `'firestore'` for `persona` / `feature` / `staticDoc`. `GENERAL_IDENTITY` stays `'knowledge-base/general'`.

- [ ] **Step 1: Add failing assertions** to the existing drift spec — extend an existing per-family `file-drift` test in each family:

```ts
expect(finding).toMatchObject({ family: 'persona', source: 'firestore' });
// and for the general-docs case:
expect(finding).toMatchObject({ family: 'general', source: 'bucket' });
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/drift.spec.ts` — expected: FAIL (no `source` property).

- [ ] **Step 3: Implement** — in `drift.ts`: add `source: 'firestore' | 'bucket'` to `DriftFinding`; in the `compare` helper that constructs findings:

```ts
const sourceFor = (family: DriftFamily): 'firestore' | 'bucket' => (family === 'general' ? 'bucket' : 'firestore');
```

set `source: sourceFor(family)` on every finding; include it in `renderDrift`'s per-finding line (e.g. `` `${f.family} ${f.identity} [${f.source}]` ``); update the `DriftKind` doc comment's "file on disk" wording to "stored content".

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/benchmark/drift.spec.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/drift.ts src/benchmark/drift.spec.ts
git commit -m "feat(benchmark): drift findings name their source store"
```

---

### Task 4: Migrate SevenKeysService to snapshot-threaded inputs

**Files:**
- Modify: `src/benchmark/seven-keys/seven-keys.service.ts`
- Modify: `src/benchmark/seven-keys/seven-keys.service.spec.ts`
- Modify: `src/benchmark/seven-keys/seven-keys.spec.ts` (if it constructs the service)

**Interfaces:**
- Consumes: `CloudInputsService`, `DayInput`, `InputsSnapshot` from `../cloud-inputs.service`.
- Produces: `generate(day: DayInput, snap: InputsSnapshot): Promise<KeysArtifact>`, `ensureKeys(day: DayInput, snap: InputsSnapshot, opts?: { force?: boolean; pinned?: boolean }): Promise<DayArtifactDoc | null>`; `computeInputsHash(day: DayInput, methodsDoc: string): string` stays synchronous and pure — hashed from the SAME in-memory values generation consumes, never a second fetch.

- [ ] **Step 1: Update the spec's fixtures** — content-bearing days plus a snapshot object; delete any `readFileSync`/temp-file machinery:

```ts
const day: DayInput = {
  day: '07012026', date: '2026-07-01', prefix: '07012026', recapDate: '06302026',
  fileSha256: { tradePlanMd: 'x', tradePlanPdf: 'y', recap: 'z' },
  pdf: Buffer.from('PDF'), tpTranscript: 'PLAN', recapTranscript: 'RECAP',
  recapFileName: '06302026_ES_RECAP.md',
};
const snap: InputsSnapshot = {
  traders: [], features: [],
  general: { files: [], concatenated: 'GEN', sha256: 'g' },
  methodsDoc: 'METHODS',
  days: [], issues: [],
};
const inputs = {
  priorCompleteDays: jest.fn(() => []),          // now sync + pure
  outcomeRecapForDay: jest.fn(async () => null),
};
```

Every behavioral assertion stays; the missing-methods-doc test asserts `generate(day, { ...snap, methodsDoc: null })` rejects. Where the spec asserted `computeInputsHash` behavior, call it as `(service as any).computeInputsHash(day, 'METHODS')` and assert the `\x00`-separated scheme over `day.pdf`/`day.tpTranscript`/`day.recapTranscript`/methods.

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/seven-keys/seven-keys.service.spec.ts` — expected: FAIL.

- [ ] **Step 3: Implement:**
  - Swap imports: `CloudInputsService, DayInput, InputsSnapshot` from `../cloud-inputs.service`; constructor param type `CloudInputsService`; delete the `node:fs` import.
  - `generate(day: DayInput, snap: InputsSnapshot)`: `const methodsDoc = snap.methodsDoc; if (!methodsDoc) throw new Error(...)` (unchanged message); `const general = snap.general;` `const tpTranscript = day.tpTranscript;` `const recapTranscript = day.recapTranscript;` `const prior = this.inputs.priorCompleteDays(day.day, snap);` and in the lookback loop `const outcomeRecap = await this.inputs.outcomeRecapForDay(p.day, snap);` passed directly.
  - `computeInputsHash` becomes pure:

```ts
  private computeInputsHash(day: DayInput, methodsDoc: string): string {
    return createHash('sha256')
      .update(day.pdf).update('\x00')
      .update(day.tpTranscript).update('\x00')
      .update(day.recapTranscript).update('\x00')
      .update(methodsDoc)
      .digest('hex');
  }
```

  - `ensureKeys(day: DayInput, snap: InputsSnapshot, opts?)`: `const inputsHash = this.computeInputsHash(day, snap.methodsDoc ?? '');` and pass `snap` through to `this.generate(day, snap)`.

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/benchmark/seven-keys/seven-keys.service.spec.ts src/benchmark/seven-keys/seven-keys.spec.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/seven-keys/
git commit -m "refactor(benchmark): seven-keys consumes the run snapshot; inputsHash from in-memory values"
```

---

### Task 5: Migrate remaining consumers; single-flight run; delete RepoInputsService

**Files:**
- Modify: `src/benchmark/benchmark.service.ts`
- Modify: `src/benchmark/scoreboard.service.ts`
- Modify: `src/benchmark/cache-warmer.ts`
- Modify: `src/benchmark/benchmark.module.ts`
- Delete: `src/benchmark/repo-inputs.service.ts`, `src/benchmark/repo-inputs.service.spec.ts`
- Modify: `src/benchmark/benchmark.service.spec.ts`, `src/benchmark/scoreboard.service.spec.ts`, `src/benchmark/cache-warmer.spec.ts`
- Modify: `src/config/configuration.ts` (remove `benchmark.repoRoot` + the `BENCHMARK_REPO_ROOT` read; the `resolve` import STAYS — `eminiplayer.screenshotDir` uses it) and `src/config/configuration.spec.ts` (drop repoRoot assertions)

**Interfaces:**
- Consumes: `snapshot()`, `loadDay(listing)`, `priorCompleteDays(day, snap)` from Tasks 1–2; seven-keys `(day, snap)` signatures from Task 4.
- Produces: `run()` is single-flight (409 `ConflictException` when already running), refuses empty traders/features with `UnprocessableEntityException`, takes ONE snapshot; `assembleDay(day: DayInput)`.

- [ ] **Step 1: Update the three consumer specs.** The inputs fake is now snapshot-shaped — spell it out (this replaces the old per-method `collect*` mocks):

```ts
const listing: DayListing = {
  day: '07012026', date: '2026-07-01', prefix: '07012026', recapDate: '06302026',
  fileSha256: { tradePlanMd: 'x', tradePlanPdf: 'y', recap: 'z' },
};
const snapValue: InputsSnapshot = {
  traders: [{ name: 'context-trader', origin: null, mutation: null, content: 'C', sha256: 'ts' }],
  features: [{ id: 'seven-keys-scorecard', name: 'SK', block: 'B', sha256: 'fs', staticDocContent: 'M', staticDocSha256: 'ms', artifactSuffix: '_ES_KEYS.md' }],
  general: { files: [], concatenated: 'GEN', sha256: 'gs' },
  methodsDoc: 'M',
  days: [listing],
  issues: [],
};
const inputs = {
  snapshot: jest.fn(async () => snapValue),
  loadDay: jest.fn(async (l: DayListing) => ({
    ...l, pdf: Buffer.from('PDF'), tpTranscript: 'PLAN', recapTranscript: 'RECAP', recapFileName: '06302026_ES_RECAP.md',
  })),
  priorCompleteDays: jest.fn(() => []),
  outcomeRecapForDay: jest.fn(async () => null),
};
```

Add three new failing tests to `benchmark.service.spec.ts`:

```ts
it('refuses to run with zero traders', async () => {
  inputs.snapshot.mockResolvedValueOnce({ ...snapValue, traders: [] });
  await expect(service.run({})).rejects.toThrow(/no traders/i);
});
it('refuses to run with zero features', async () => {
  inputs.snapshot.mockResolvedValueOnce({ ...snapValue, features: [] });
  await expect(service.run({})).rejects.toThrow(/no features/i);
});
it('a second concurrent run gets 409', async () => {
  let release!: () => void;
  inputs.snapshot.mockImplementationOnce(() => new Promise((r) => { release = () => r(snapValue); }));
  const first = service.run({});
  await expect(service.run({})).rejects.toThrow(/already in progress/i);
  release();
  await first;
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/benchmark.service.spec.ts src/benchmark/scoreboard.service.spec.ts src/benchmark/cache-warmer.spec.ts` — expected: FAIL.

- [ ] **Step 3: Migrate `benchmark.service.ts`:**
  - Imports: swap `RepoInputsService, DayInput, TraderInput, FeatureInput` for `CloudInputsService, InputsSnapshot, DayListing, DayInput, TraderInput, FeatureInput` from `./cloud-inputs.service`; delete the `node:fs` import; add `ConflictException, UnprocessableEntityException` to the `@nestjs/common` import.
  - Constructor: `private readonly inputs: CloudInputsService`.
  - `checkDrift()` (line 75):

```ts
  async checkDrift(): Promise<DriftReport> {
    const snap = await this.inputs.snapshot();
    return detectDrift(this.driftInputs(snap.traders, snap.features, snap.general.sha256), await this.repo.listCellsForDrift());
  }
```

  - Single-flight + one snapshot in `run()` — wrap the existing body:

```ts
  private runInProgress = false;

  async run(opts: RunOptions = {}): Promise<RunSummary> {
    // Single-flight: two concurrent runs racing ensureKeys can orphan a
    // submitted batch's pinned KEYS hash (last-write-wins saveKeysArtifact) —
    // a permanent per-day wedge. Same posture as BatchReconciler's guard.
    if (this.runInProgress) throw new ConflictException('a benchmark run is already in progress');
    this.runInProgress = true;
    try {
      return await this.runInner(opts);
    } finally {
      this.runInProgress = false;
    }
  }

  private async runInner(opts: RunOptions): Promise<RunSummary> {
    // ...existing body of run(), migrated as below...
  }
```

  - In `runInner`, replace the three collects + days/issues reads (old lines 90–115) with:

```ts
    const snap = await this.inputs.snapshot();
    const { traders, features, general } = snap;
    if (!traders.length) throw new UnprocessableEntityException('no traders in Firestore — create personas via POST /traders before running');
    if (!features.length) throw new UnprocessableEntityException('no features in Firestore — create variants via POST /features before running');
    const featureById = new Map(features.map((f) => [f.id, f]));
    // drift guard unchanged, fed from the snapshot
    const drift = detectDrift(this.driftInputs(traders, features, general.sha256), await this.repo.listCellsForDrift());
    ...
    let days = snap.days;
    if (opts.days?.length) days = days.filter((d) => opts.days!.includes(d.day));
    ...
    let issues = snap.issues;
    if (opts.days?.length) issues = issues.filter((i) => opts.days!.includes(i.day));
```

  - Inside the per-day `try` (after the candles/coverage checks pass, before assembly): `const dayInput = await this.inputs.loadDay(day);` then `const bundle = await this.assembleDay(dayInput);` and `this.sevenKeys.ensureKeys(dayInput, snap, { force: ..., pinned: ... })` (a `loadDay` verification mismatch throws into the existing per-day catch → `daysSkipped`).
  - `assembleDay` (line 303):

```ts
  private async assembleDay(day: DayInput): Promise<{ dayBundle: DayBundle }> {
    const pdf = await this.dayArtifacts.ensurePdf(day.day, day.prefix, day.pdf);
    await this.dayArtifacts.ensureTranscript(day.day, 'tpTranscript', `${day.prefix}_ES_TP.md`, day.tpTranscript);
    await this.dayArtifacts.ensureTranscript(day.day, 'recapTranscript', day.recapFileName, day.recapTranscript);
    return {
      dayBundle: { date: day.date, fileId: pdf.providerFileId, tpTranscript: day.tpTranscript, recapTranscript: day.recapTranscript },
    };
  }
```

- [ ] **Step 4: Migrate `scoreboard.service.ts`** — swap the import/constructor type; lines 18-19 become:

```ts
    const snap = await this.inputs.snapshot();
    const traders = snap.traders.map((t) => ({ name: t.name, origin: t.origin, mutation: t.mutation }));
    const features = snap.features.map((f) => ({ id: f.id, name: f.name }));
```

- [ ] **Step 5: Migrate `cache-warmer.ts`** — swap the import/constructor type; lines 53-55 become:

```ts
    const snap = await this.inputs.snapshot();
    const general = snap.general.concatenated;
    const traders = new Map(snap.traders.map((t) => [t.name, t]));
    const features = new Map(snap.features.map((f) => [f.id, f]));
```

(Note: `warm()` runs inside the scheduler's existing `.catch(log)` — a 503 from `snapshot()` logs and waits for the next tick; no new handling needed.)

- [ ] **Step 6: Rewire `benchmark.module.ts`** — replace the `RepoInputsService` import/provider with `CloudInputsService`. `git rm src/benchmark/repo-inputs.service.ts src/benchmark/repo-inputs.service.spec.ts`. In `configuration.ts`, remove the `repoRoot` key and its comment (the `resolve` import stays — `eminiplayer.screenshotDir` uses it); drop the repoRoot assertions in `configuration.spec.ts`.

- [ ] **Step 7: Run the full unit suite** — `pnpm test` — expected: PASS (any straggler suite still importing `repo-inputs.service` gets its import + fake migrated to the snapshot idiom from Step 1).

- [ ] **Step 8: Commit**

```bash
git add -A src/benchmark src/config
git commit -m "refactor(benchmark): snapshot-threaded consumers, single-flight run; drop RepoInputsService"
```

---

### Task 6: Content write endpoints (ContentModule)

**Files:**
- Create: `src/content/content.module.ts`, `src/content/content.service.ts`, `src/content/content.controller.ts`
- Create: `src/content/content.service.spec.ts`, `src/content/content.controller.spec.ts`
- Modify: `src/app.module.ts` (add `ContentModule` to imports)

**Interfaces:**
- Consumes: `FIRESTORE`, `STORAGE_BUCKET`; `parseFrontmatter` from `src/common/markdown-frontmatter`; `TRADERS_COLLECTION`, `FEATURES_COLLECTION`, `GENERAL_PREFIX`, `generalDocPath`, `METHODS_PATH` from `src/benchmark/cloud-inputs.service` (single home of the paths — do NOT redefine them here).
- Produces HTTP surface (bodies are JSON):
  - `POST /traders` `{ content }` → 201 `{ name, sha256 }`; 400 missing/invalid `name` frontmatter (lineage OPTIONAL — root personas allowed); 409 exists
  - `POST /features` `{ content }` → 201 `{ id, sha256 }`; 400 missing `id`; 409 exists
  - `PUT /knowledge/general/:name` `{ content }` → 200 `{ path, sha256 }`; 400 invalid `:name`
  - `PUT /knowledge/methods` `{ content }` → 200 `{ path, sha256 }`
  - `GET /traders` → `[{ name, origin, mutation, sha256 }]`; `GET /features` → `[{ id, name, sha256 }]`; `GET /knowledge/general` → `[{ path, sha256 }]` (sha256 from downloaded content)

- [ ] **Step 1: Write failing service specs**

```ts
// src/content/content.service.spec.ts
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
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/content/content.service.spec.ts` — expected: FAIL (module not found).

- [ ] **Step 3: Implement `content.service.ts`**

```ts
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { parseFrontmatter } from '../common/markdown-frontmatter';
import {
  TRADERS_COLLECTION,
  FEATURES_COLLECTION,
  GENERAL_PREFIX,
  generalDocPath,
  METHODS_PATH,
} from '../benchmark/cloud-inputs.service';

const NAME_RE = /^[A-Za-z0-9_-]+$/; // doubles as a path-traversal guard for bucket keys

interface WritableBucketLike {
  file(path: string): {
    save(content: string, opts?: object): Promise<unknown> | unknown;
    download(): Promise<[Buffer]>;
  };
  getFiles(opts: { prefix: string }): Promise<[{ name: string }[]]>;
}

@Injectable()
export class ContentService {
  constructor(
    @Inject(FIRESTORE) private readonly db: Firestore,
    @Inject(STORAGE_BUCKET) private readonly bucket: WritableBucketLike,
  ) {}

  private sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // Firestore create() is atomic write-once; ALREADY_EXISTS (gRPC code 6) maps to 409.
  private async createOnce(collection: string, id: string, data: object): Promise<void> {
    try {
      await this.db.collection(collection).doc(id).create(data);
    } catch (err) {
      if ((err as { code?: number }).code === 6) {
        throw new ConflictException(
          `${collection}/${id} already exists — content is write-once; create a new ${collection === TRADERS_COLLECTION ? 'persona' : 'feature'} instead`,
        );
      }
      throw err;
    }
  }

  /**
   * Lineage (origin/mutation) is OPTIONAL: a root persona — the head of a
   * family tree — legitimately has neither. Only `name` is required.
   */
  async createTrader(content: string): Promise<{ name: string; sha256: string }> {
    const fm = parseFrontmatter(content);
    if (!fm.name) throw new BadRequestException('persona frontmatter must declare: name');
    if (!NAME_RE.test(fm.name)) throw new BadRequestException(`invalid persona name: ${fm.name}`);
    const sha256 = this.sha256(content);
    await this.createOnce(TRADERS_COLLECTION, fm.name, { name: fm.name, content, sha256, createdAt: new Date().toISOString() });
    return { name: fm.name, sha256 };
  }

  async createFeature(content: string): Promise<{ id: string; sha256: string }> {
    const fm = parseFrontmatter(content);
    if (!fm.id) throw new BadRequestException('feature frontmatter must declare: id');
    if (!NAME_RE.test(fm.id)) throw new BadRequestException(`invalid feature id: ${fm.id}`);
    const sha256 = this.sha256(content);
    await this.createOnce(FEATURES_COLLECTION, fm.id, { id: fm.id, content, sha256, createdAt: new Date().toISOString() });
    return { id: fm.id, sha256 };
  }

  async putGeneral(name: string, content: string): Promise<{ path: string; sha256: string }> {
    if (!NAME_RE.test(name)) throw new BadRequestException(`invalid general-doc name: ${name}`);
    const path = generalDocPath(name);
    await this.bucket.file(path).save(content, { contentType: 'text/markdown' });
    return { path, sha256: this.sha256(content) };
  }

  async putMethods(content: string): Promise<{ path: string; sha256: string }> {
    await this.bucket.file(METHODS_PATH).save(content, { contentType: 'text/markdown' });
    return { path: METHODS_PATH, sha256: this.sha256(content) };
  }

  async listTraders(): Promise<{ name: string; origin: string | null; mutation: string | null; sha256: string }[]> {
    const snap = await this.db.collection(TRADERS_COLLECTION).get();
    return snap.docs
      .map((d) => d.data() as { name: string; content: string })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((doc) => {
        const fm = parseFrontmatter(doc.content);
        return { name: doc.name, origin: fm.origin || null, mutation: fm.mutation || null, sha256: this.sha256(doc.content) };
      });
  }

  async listFeatures(): Promise<{ id: string; name: string; sha256: string }[]> {
    const snap = await this.db.collection(FEATURES_COLLECTION).get();
    return snap.docs
      .map((d) => d.data() as { id: string; content: string })
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => ({ id: doc.id, name: parseFrontmatter(doc.content).name || doc.id, sha256: this.sha256(doc.content) }));
  }

  async listGeneral(): Promise<{ path: string; sha256: string }[]> {
    const [objects] = await this.bucket.getFiles({ prefix: GENERAL_PREFIX });
    const paths = objects.map((o) => o.name).sort();
    return Promise.all(
      paths.map(async (path) => {
        const [buf] = await this.bucket.file(path).download();
        return { path, sha256: this.sha256(buf.toString('utf8')) };
      }),
    );
  }
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/content/content.service.spec.ts` — expected: PASS.

- [ ] **Step 5: Controller + module + wiring.** Controller spec (`content.controller.spec.ts`): instantiate with a jest-mocked service and assert each route delegates with the right arguments — the same delegation idiom as the existing `src/benchmark/benchmark.controller.spec.ts`.

```ts
// src/content/content.controller.ts
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ContentService } from './content.service';

@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  private requireContent(body: { content?: string }): string {
    if (typeof body?.content !== 'string' || !body.content.length) throw new BadRequestException('body.content (string) is required');
    return body.content;
  }

  @Post('traders')
  createTrader(@Body() body: { content?: string }) {
    return this.content.createTrader(this.requireContent(body));
  }

  @Get('traders')
  listTraders() {
    return this.content.listTraders();
  }

  @Post('features')
  createFeature(@Body() body: { content?: string }) {
    return this.content.createFeature(this.requireContent(body));
  }

  @Get('features')
  listFeatures() {
    return this.content.listFeatures();
  }

  @Put('knowledge/general/:name')
  @HttpCode(200)
  putGeneral(@Param('name') name: string, @Body() body: { content?: string }) {
    return this.content.putGeneral(name, this.requireContent(body));
  }

  @Get('knowledge/general')
  listGeneral() {
    return this.content.listGeneral();
  }

  @Put('knowledge/methods')
  @HttpCode(200)
  putMethods(@Body() body: { content?: string }) {
    return this.content.putMethods(this.requireContent(body));
  }
}
```

```ts
// src/content/content.module.ts
import { Module } from '@nestjs/common';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';

@Module({ controllers: [ContentController], providers: [ContentService] })
export class ContentModule {}
```

Add `ContentModule` to `src/app.module.ts` imports.

- [ ] **Step 6: Run** — `pnpm test -- --runTestsByPath src/content/content.service.spec.ts src/content/content.controller.spec.ts` — expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/content src/app.module.ts
git commit -m "feat(content): write-once persona/feature endpoints + knowledge doc uploads"
```

---

### Task 7: E2e suite migration

**Files:**
- Modify: `test/benchmark.e2e-spec.ts`
- Modify: `test/benchmark-scorecard.e2e-spec.ts`

**Interfaces:**
- Consumes: `fakeFirestore()` from `test/fake-firestore.ts` (supports `.doc().set()` and write-once `create()` with `{code: 6}`); each suite's local `fakeBucket()` (holds `saved: Record<string, Buffer>`).

- [ ] **Step 1: Extend each suite's `fakeBucket()`** with `getFiles`:

```ts
    getFiles: ({ prefix }: { prefix: string }) =>
      Promise.resolve([Object.keys(saved).filter((n) => n.startsWith(prefix)).map((name) => ({ name }))] as [
        { name: string }[],
      ]),
```

- [ ] **Step 2: Restructure boot to hold the fakes, then seed them.** The suites currently construct fakes inline (`.overrideProvider(STORAGE_BUCKET).useValue(fakeBucket())` — instance never held), and `seedRepo()` writes a temp dir. Replace both:

```ts
// module-scope in each suite:
const db = fakeFirestore();
const bucket = fakeBucket();

// in the Test.createTestingModule chain, use the HELD instances:
//   .overrideProvider(FIRESTORE).useValue(db)
//   .overrideProvider(STORAGE_BUCKET).useValue(bucket)

import { createHash } from 'node:crypto';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function seedCloud() {
  // Keep the suites' EXISTING content strings byte-for-byte (context-trader is
  // a root persona — no lineage lines) so any content-derived assertion keeps
  // its meaning.
  db.collection('traders').doc('context-trader').set({
    name: 'context-trader',
    content: '---\nname: context-trader\n---\nbody',
  });
  db.collection('features').doc('seven-keys-scorecard').set({
    id: 'seven-keys-scorecard',
    content: '---\nid: seven-keys-scorecard\nname: Seven Keys Scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\n---\nblock',
  });
  bucket.saved['knowledge-base/general/g.md'] = Buffer.from('GEN');
  bucket.saved['knowledge-base/methods/seven-keys.md'] = Buffer.from('METHODS');
  bucket.saved['knowledge-base/es/07012026/manifest.json'] = Buffer.from(JSON.stringify({
    date: '07012026',
    recapDate: '06302026',
    files: {
      tradePlanMd: { sha256: sha('PLAN') },
      tradePlanPdf: { sha256: sha('PDF') },
      recap: { sha256: sha('RECAP') },
    },
  }));
  bucket.saved['knowledge-base/es/07012026/07012026_ES_TP.pdf'] = Buffer.from('PDF');
  bucket.saved['knowledge-base/es/07012026/07012026_ES_TP.md'] = Buffer.from('PLAN');
  bucket.saved['knowledge-base/es/07012026/06302026_ES_RECAP.md'] = Buffer.from('RECAP');
}
```

Delete the `mkdtempSync`/`seedRepo`/`BENCHMARK_REPO_ROOT` machinery and the now-unused `node:fs`/`node:os`/`node:path` imports. The manifests MUST carry the `files` sha256 records or every `loadDay` fails verification.

- [ ] **Step 3: Fix the direct service calls.** Replace `RepoInputsService` imports with `CloudInputsService`; the sync read at `test/benchmark.e2e-spec.ts:300` becomes:

```ts
const generalSha = (await moduleRef.get(CloudInputsService).snapshot()).general.sha256;
```

Note: `benchmark.e2e-spec.ts`'s old `seedRepo` created an EMPTY `features/` dir; after Task 5's zero-features refusal the suite hard-depends on `seedCloud` seeding a feature — do not "simplify" the feature seed away.

- [ ] **Step 4: Run** — `pnpm test:e2e -- --runTestsByPath test/benchmark.e2e-spec.ts test/benchmark-scorecard.e2e-spec.ts` — then the full suites: `pnpm test && pnpm test:e2e` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test(e2e): benchmark suites seed cloud fakes instead of a temp repo"
```

---

### Task 8: Fresh-era wipe + content migration + verification gate

No code files — this runs against the local backend (`cd backend && pnpm start`, ADC configured, project `app-foster-bridge`) and is the acceptance gate. Run the curl/git steps from the **repo root**. Every step chains with `&&` and uses `curl -sS --fail-with-body` so any 4xx/5xx halts loudly.

- [ ] **Step 1: Confirm nothing is in flight, then wipe the old era.** This deletes ALL skills-era benchmark data (cells, batches, scoreboards, day artifacts incl. KEYS) — the clean-slate decision. It also retires the legacy MES-era cells, mooting CLAUDE.md's mixing warning.

```bash
curl -sS --fail-with-body localhost:3000/benchmark/status   # MUST show {"batches":[]}
npx --yes firebase-tools firestore:delete --project app-foster-bridge -r benchmarkRuns --force \
  && npx --yes firebase-tools firestore:delete --project app-foster-bridge -r benchmarkBatches --force \
  && npx --yes firebase-tools firestore:delete --project app-foster-bridge -r benchmarkScoreboard --force \
  && npx --yes firebase-tools firestore:delete --project app-foster-bridge -r dayArtifacts --force
```

(Fallback: delete the four collections in the Firebase console.)

- [ ] **Step 2: Import the two personas** (still on disk; context-trader is a root persona — no lineage, accepted by design):

```bash
jq -Rs '{content: .}' traders/context-trader.md    | curl -sS --fail-with-body -X POST localhost:3000/traders  -H 'content-type: application/json' -d @- \
  && jq -Rs '{content: .}' traders/context-structured.md | curl -sS --fail-with-body -X POST localhost:3000/traders  -H 'content-type: application/json' -d @-
```

- [ ] **Step 3: Import the two features** (content only — their `staticDoc` frontmatter resolves live against the bucket methods doc; `HEAD:` consistently):

```bash
git show HEAD:features/seven-keys-method.md    | jq -Rs '{content: .}' | curl -sS --fail-with-body -X POST localhost:3000/features -H 'content-type: application/json' -d @- \
  && git show HEAD:features/seven-keys-scorecard.md | jq -Rs '{content: .}' | curl -sS --fail-with-body -X POST localhost:3000/features -H 'content-type: application/json' -d @-
```

- [ ] **Step 4: Upload the shared docs:**

```bash
git show HEAD:knowledge-base/general/support_and_resistance_zones.md | jq -Rs '{content: .}' | curl -sS --fail-with-body -X PUT localhost:3000/knowledge/general/support_and_resistance_zones -H 'content-type: application/json' -d @- \
  && git show HEAD:knowledge-base/methods/seven-keys.md | jq -Rs '{content: .}' | curl -sS --fail-with-body -X PUT localhost:3000/knowledge/methods -H 'content-type: application/json' -d @-
```

- [ ] **Step 5: Acceptance gate — ALL must pass.** The drift check cannot detect a missing input (absent inputs are skipped by design), so the listings are load-bearing:

```bash
curl -sS --fail-with-body localhost:3000/traders            # exactly: context-structured, context-trader (with origin/mutation on the child, nulls on the root)
curl -sS --fail-with-body localhost:3000/features           # exactly: seven-keys-method, seven-keys-scorecard
curl -sS --fail-with-body localhost:3000/knowledge/general  # the zones doc, sha256 matching:
git show HEAD:knowledge-base/general/support_and_resistance_zones.md | shasum -a 256
curl -sS --fail-with-body localhost:3000/benchmark/drift    # {"findings":[],"cellsExamined":0}
```

If any check fails, STOP and fix before Task 9 — features/personas are write-once, so a bad import means deleting the Firestore doc by hand before retrying.

---

### Task 9: Repo cleanup + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (repo root)
- Delete (commit the pending deletions + newly-migrated files): `knowledge-base/`, `features/`, `traders/`, `.claude/skills/ingest-ticker-data/`, `.claude/skills/seven-keys/`, `.claude/skills/trader-bench/`, `.claude/skills/trader-panel/`, `.claude/skills/trader-spawn/`

Only run after Task 8's gate passed.

- [ ] **Step 1: Stage the deletions** (from repo root):

```bash
git rm -r --quiet knowledge-base features traders .claude/skills/ingest-ticker-data .claude/skills/seven-keys .claude/skills/trader-bench .claude/skills/trader-panel .claude/skills/trader-spawn
```

(Most are already deleted from disk — `git rm` stages them; `traders/` still exists and is removed here, its content verified in Firestore by Task 8's gate.)

- [ ] **Step 2: Update `CLAUDE.md`:**
  - "Use the API, not the skills": drop "kept only as reference documentation" (they're deleted); state content lives in Firebase Storage/Firestore.
  - **Remove the legacy MES-era warning block** ("do not issue POST /benchmark/run ... until the legacy MES-era cells are retired") — those cells were deleted in Task 8; the fresh era grades ES at $50/pt from cell one.
  - "Trader personas": rewrite — personas are **write-once Firestore docs** created via `POST /traders` (frontmatter requires `name`; `origin`/`mutation` optional for root personas, recorded as lineage when present); refining a persona means a new name, never an edit; `GET /traders` lists them; Firestore is the only source of truth.
  - Benchmark section: day availability comes from committed eminiplayer manifests in the bucket (`POST /eminiplayer/ingest` is how a day becomes benchmarkable); a short "Content endpoints" heading documenting `POST /features`, `PUT /knowledge/general/:name`, `PUT /knowledge/methods`, and the three GET listings; note the methods doc has ONE copy (`PUT /knowledge/methods`) that features reference live via their `staticDoc` frontmatter; note `POST /benchmark/run` is single-flight (409 when a run is in progress).
  - Remove remaining references to `knowledge-base/` as a local directory and to `.claude/skills/trader-spawn/SKILL.md`.

- [ ] **Step 3: Final verification** — `cd backend && pnpm test && pnpm test:e2e` — expected: PASS. `curl -sS localhost:3000/benchmark/drift` — still `{"findings":[],"cellsExamined":0}`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: retire local knowledge base and skills-era benchmark data — cloud stores are the source of truth"
```

---

## Self-review notes

- v2 incorporates all 20 findings from `2026-08-16-cloud-inputs-migration-review.md` plus the clean-slate decision (no legacy-cell compatibility; era wipe in Task 8).
- Deliberate deviations from a literal reading of the spec: `loadDay(listing)` takes the listing rather than a day string (callers hold one; avoids a re-fetch); `DayListing` carries `recapDate` + `fileSha256` and `DayInput` carries `recapFileName` — supersets required by manifest verification and `assembleDay`.
- Findings resolved structurally rather than patched: the scorecard `staticDocContent` omission (review #2) and the lost methods-doc drift protection (review #3) are both eliminated by the single-copy live-resolution design — features never embed the methods doc, so there is nothing to forget at import time.
- The byte-equivalence concern (review #12) is moot: the era wipe deletes all KEYS artifacts, so first-run regeneration is expected behavior, not silent drift.
