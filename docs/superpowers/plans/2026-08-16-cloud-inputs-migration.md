# Cloud Inputs Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the benchmark's local-filesystem input layer (`RepoInputsService`) with a cloud-backed `CloudInputsService` reading from Firebase Storage (shared docs) and Firestore (personas, features), plus write endpoints and a one-time content migration.

**Architecture:** A new async `CloudInputsService` in `backend/src/benchmark/` presents the same conceptual interface as today's `RepoInputsService` but sources day docs / general docs / methods doc from the bucket (reusing the eminiplayer module's path contract) and traders / features from write-once Firestore collections. Six consumers switch to `await` + content-bearing `DayInput`. A new `ContentModule` exposes validated write endpoints. Hashing stays byte-identical so the 476 existing scorecard cells produce zero drift.

**Tech Stack:** NestJS 10, firebase-admin (Firestore + Storage), Jest. Package manager: `pnpm`, run from `backend/`.

**Spec:** `docs/superpowers/specs/2026-08-16-cloud-inputs-migration-design.md`

## Global Constraints

- All commands run from `/Users/nicholasstelter/Code/foster-bridge/backend` unless stated otherwise.
- Test command: `pnpm test -- --runTestsByPath <path>` (unit) and `pnpm test:e2e -- --runTestsByPath <path>` (e2e).
- Hashing must stay byte-identical to `RepoInputsService`: persona sha256 = sha256 of full markdown (frontmatter included); feature sha256 = sha256 of full markdown; staticDocSha256 = sha256 of the static doc content; general sha256 = sha256 of path-sorted concatenation, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` when empty.
- The drift guard keeps its no-bypass semantics. Do not add any bypass flag.
- Semantic commit messages; no Claude attributions in commits or PRs.
- Storage paths for day docs come from `src/eminiplayer/eminiplayer-validation.ts` (`ES_STORAGE_PREFIX`, `dayPaths`, `manifestPath`) — never hand-build them.
- Firestore collections: `traders` (doc id = name), `features` (doc id = id). Write-once via `create()`.

---

### Task 1: Shared frontmatter helpers + CloudInputsService (Firestore half)

**Files:**
- Create: `src/common/markdown-frontmatter.ts`
- Create: `src/benchmark/cloud-inputs.service.ts`
- Create: `src/benchmark/cloud-inputs.service.spec.ts`

**Interfaces:**
- Consumes: `FIRESTORE`, `STORAGE_BUCKET` symbols from `src/firebase/firebase.constants.ts`.
- Produces (later tasks rely on these exact exports from `cloud-inputs.service.ts`):
  - `interface TraderInput { name: string; origin: string | null; mutation: string | null; content: string; sha256: string }`
  - `interface FeatureInput { id: string; name: string; block: string; sha256: string; staticDocContent: string | null; staticDocSha256: string | null; artifactSuffix: string | null }`
  - `interface GeneralDocs { files: { path: string; content: string }[]; concatenated: string; sha256: string }`
  - `interface DayListing { day: string; date: string; prefix: string; recapDate: string }`
  - `interface DayInput extends DayListing { pdf: Buffer; tpTranscript: string; recapTranscript: string; recapFileName: string }`
  - `interface DayIssue { day: string; missing: string[] }`
  - `class CloudInputsService` with `sha256(content: string): string`, `collectTraders(): Promise<TraderInput[]>`, `collectFeatures(): Promise<FeatureInput[]>` (bucket methods come in Task 2)
  - From `markdown-frontmatter.ts`: `parseFrontmatter(text: string): Record<string, string>` and `extractBlock(text: string): string` (ported verbatim from `repo-inputs.service.ts:63-91`).

- [ ] **Step 1: Create the helpers file** — move the two private functions out of `RepoInputsService` unchanged (do not edit `repo-inputs.service.ts` yet; copy):

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

- [ ] **Step 2: Write failing specs for the Firestore half**

```ts
// src/benchmark/cloud-inputs.service.spec.ts
import { CloudInputsService } from './cloud-inputs.service';

const TRADER_MD = '---\nname: context-trader\norigin: seed\nmutation: none\n---\nbody';
const FEATURE_MD = '---\nid: seven-keys-scorecard\nname: Seven Keys Scorecard\nartifactSuffix: _ES_KEYS.md\n---\nblock text';

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
      download: () => Promise.resolve([Buffer.from(objects[path])] as [Buffer]),
    }),
  } as any;
}

describe('CloudInputsService (firestore half)', () => {
  it('collectTraders maps docs, recomputes sha256 from content, sorts by name', async () => {
    const svc = new CloudInputsService(
      fakeDb({ traders: [
        { name: 'zeta', content: '---\nname: zeta\n---\nz', sha256: 'stale-ignored' },
        { name: 'context-trader', content: TRADER_MD, sha256: 'stale-ignored' },
      ] }),
      fakeBucket(),
    );
    const traders = await svc.collectTraders();
    expect(traders.map((t) => t.name)).toEqual(['context-trader', 'zeta']);
    expect(traders[0]).toMatchObject({ origin: 'seed', mutation: 'none', content: TRADER_MD });
    expect(traders[0].sha256).toBe(svc.sha256(TRADER_MD)); // recomputed, not trusted
  });

  it('collectFeatures derives block/hashes from content, sorts by id', async () => {
    const svc = new CloudInputsService(
      fakeDb({ features: [{ id: 'seven-keys-scorecard', content: FEATURE_MD, staticDocContent: 'METHOD' }] }),
      fakeBucket(),
    );
    const [f] = await svc.collectFeatures();
    expect(f).toMatchObject({
      id: 'seven-keys-scorecard',
      name: 'Seven Keys Scorecard',
      block: 'block text',
      artifactSuffix: '_ES_KEYS.md',
      staticDocContent: 'METHOD',
    });
    expect(f.sha256).toBe(svc.sha256(FEATURE_MD));
    expect(f.staticDocSha256).toBe(svc.sha256('METHOD'));
  });

  it('empty collections return []', async () => {
    const svc = new CloudInputsService(fakeDb({}), fakeBucket());
    expect(await svc.collectTraders()).toEqual([]);
    expect(await svc.collectFeatures()).toEqual([]);
  });

  it('wraps a rejecting firestore read in ServiceUnavailableException', async () => {
    const db = { collection: () => ({ get: () => Promise.reject(new Error('UNAVAILABLE')) }) } as any;
    const svc = new CloudInputsService(db, fakeBucket());
    await expect(svc.collectTraders()).rejects.toThrow('inputs unavailable');
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/cloud-inputs.service.spec.ts` — expected: FAIL, cannot find module `./cloud-inputs.service`.

- [ ] **Step 4: Implement the service (Firestore half + constructor + wrap)**

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

// ---- shapes (unchanged fields keep the exact names consumers already use) ----
export interface TraderInput {
  name: string;
  origin: string | null;
  mutation: string | null;
  content: string;
  sha256: string;
}
export interface FeatureInput {
  id: string;
  name: string;
  block: string;
  sha256: string;
  staticDocContent: string | null;
  staticDocSha256: string | null;
  artifactSuffix: string | null;
}
export interface GeneralDocs {
  files: { path: string; content: string }[];
  concatenated: string;
  sha256: string;
}
export interface DayListing {
  day: string; // MMDDYYYY (folder + cell key)
  date: string; // YYYY-MM-DD
  prefix: string; // TP filename prefix (== day in the bucket layout)
  recapDate: string; // MMDDYYYY prefix of the recap file, from the manifest
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

  // Fail-closed: an unreachable input store must abort before anything is
  // uploaded or submitted, as a 503 rather than an opaque 500.
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new ServiceUnavailableException(`inputs unavailable: ${(err as Error).message}`);
    }
  }

  async collectTraders(): Promise<TraderInput[]> {
    const snap = await this.wrap(() => this.db.collection(TRADERS_COLLECTION).get());
    return snap.docs
      .map((d) => d.data() as { name: string; content: string })
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

  async collectFeatures(): Promise<FeatureInput[]> {
    const snap = await this.wrap(() => this.db.collection(FEATURES_COLLECTION).get());
    return snap.docs
      .map((d) => d.data() as { id: string; content: string; staticDocContent?: string | null })
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => {
        const fm = parseFrontmatter(doc.content);
        const staticDocContent = doc.staticDocContent ?? null;
        return {
          id: doc.id,
          name: fm.name || doc.id,
          block: extractBlock(doc.content),
          sha256: this.sha256(doc.content),
          staticDocContent,
          staticDocSha256: staticDocContent ? this.sha256(staticDocContent) : null,
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
git commit -m "feat(benchmark): CloudInputsService firestore half (traders, features)"
```

---

### Task 2: CloudInputsService — bucket half (days, general, methods, recaps)

**Files:**
- Modify: `src/benchmark/cloud-inputs.service.ts`
- Modify: `src/benchmark/cloud-inputs.service.spec.ts`

**Interfaces:**
- Consumes: `ES_STORAGE_PREFIX`, `dayPaths(date, recapDate)`, `manifestPath(date)` from `src/eminiplayer/eminiplayer-validation.ts`.
- Produces (exact methods later tasks call):
  - `collectGeneralDocs(): Promise<GeneralDocs>`
  - `readMethodsDoc(): Promise<string | null>` — reads `knowledge-base/methods/seven-keys.md`
  - `collectDays(): Promise<DayListing[]>` — manifest-committed days, sorted asc by date
  - `collectDayIssues(): Promise<DayIssue[]>`
  - `loadDay(listing: DayListing): Promise<DayInput>`
  - `priorCompleteDays(targetDay: string): Promise<DayListing[]>`
  - `outcomeRecapForDay(day: string): Promise<string | null>`

- [ ] **Step 1: Add failing specs**

```ts
// append to src/benchmark/cloud-inputs.service.spec.ts
const manifest = (date: string, recapDate: string) => JSON.stringify({ date, recapDate });

function seededBucket() {
  return fakeBucket({
    'knowledge-base/general/a.md': 'AAA',
    'knowledge-base/general/b.md': 'BBB',
    'knowledge-base/methods/seven-keys.md': 'METHODS',
    'knowledge-base/es/07012026/manifest.json': manifest('07012026', '06302026'),
    'knowledge-base/es/07012026/07012026_ES_TP.md': 'PLAN1',
    'knowledge-base/es/07012026/07012026_ES_TP.pdf': 'PDF1',
    'knowledge-base/es/07012026/06302026_ES_RECAP.md': 'RECAP0630',
    'knowledge-base/es/07022026/manifest.json': manifest('07022026', '07012026'),
    'knowledge-base/es/07022026/07022026_ES_TP.md': 'PLAN2',
    'knowledge-base/es/07022026/07022026_ES_TP.pdf': 'PDF2',
    'knowledge-base/es/07022026/07012026_ES_RECAP.md': 'RECAP0701',
    // committed manifest but a missing artifact -> issue, not a day
    'knowledge-base/es/07062026/manifest.json': manifest('07062026', '07022026'),
    'knowledge-base/es/07062026/07062026_ES_TP.md': 'PLAN3',
  });
}

describe('CloudInputsService (bucket half)', () => {
  const svc = () => new CloudInputsService(fakeDb({}), seededBucket());

  it('collectGeneralDocs concatenates path-sorted docs; empty prefix hashes to the zero sentinel', async () => {
    const g = await svc().collectGeneralDocs();
    expect(g.concatenated).toBe('AAABBB');
    expect(g.sha256).toBe(svc().sha256('AAABBB'));
    const empty = await new CloudInputsService(fakeDb({}), fakeBucket()).collectGeneralDocs();
    expect(empty.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('readMethodsDoc returns content, or null when absent', async () => {
    expect(await svc().readMethodsDoc()).toBe('METHODS');
    expect(await new CloudInputsService(fakeDb({}), fakeBucket()).readMethodsDoc()).toBeNull();
  });

  it('collectDays lists only fully-present manifest days, asc by date', async () => {
    const days = await svc().collectDays();
    expect(days.map((d) => d.day)).toEqual(['07012026', '07022026']);
    expect(days[0]).toMatchObject({ date: '2026-07-01', prefix: '07012026', recapDate: '06302026' });
  });

  it('collectDayIssues reports a manifest day with missing artifacts', async () => {
    const issues = await svc().collectDayIssues();
    expect(issues).toEqual([
      { day: '07062026', missing: expect.arrayContaining([expect.stringContaining('_ES_TP.pdf'), expect.stringContaining('_ES_RECAP.md')]) },
    ]);
  });

  it('loadDay downloads all three artifacts and derives recapFileName', async () => {
    const [first] = await svc().collectDays();
    const day = await svc().loadDay(first);
    expect(day.pdf.toString()).toBe('PDF1');
    expect(day.tpTranscript).toBe('PLAN1');
    expect(day.recapTranscript).toBe('RECAP0630');
    expect(day.recapFileName).toBe('06302026_ES_RECAP.md');
  });

  it('priorCompleteDays returns strictly-earlier listings', async () => {
    const prior = await svc().priorCompleteDays('07022026');
    expect(prior.map((d) => d.day)).toEqual(['07012026']);
  });

  it('outcomeRecapForDay scans every folder for <day>_ES_RECAP.md', async () => {
    expect(await svc().outcomeRecapForDay('07012026')).toBe('RECAP0701'); // lives in 07022026/
    expect(await svc().outcomeRecapForDay('07022026')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/cloud-inputs.service.spec.ts` — expected: new describe FAILs (methods undefined).

- [ ] **Step 3: Implement the bucket half** (append to the class; add imports `ES_STORAGE_PREFIX, dayPaths` from `../eminiplayer/eminiplayer-validation`):

```ts
  private readonly generalPrefix = 'knowledge-base/general/';
  private readonly methodsPath = 'knowledge-base/methods/seven-keys.md';

  private async download(path: string): Promise<Buffer> {
    const [buf] = await this.bucket.file(path).download();
    return buf;
  }

  async collectGeneralDocs(): Promise<GeneralDocs> {
    return this.wrap(async () => {
      const [objects] = await this.bucket.getFiles({ prefix: this.generalPrefix });
      const paths = objects.map((o) => o.name).filter((n) => !n.endsWith('/')).sort();
      const files = await Promise.all(
        paths.map(async (path) => ({ path, content: (await this.download(path)).toString('utf8') })),
      );
      const concatenated = files.map((f) => f.content).join('');
      return { files, concatenated, sha256: concatenated ? this.sha256(concatenated) : ZERO_BYTES_SHA256 };
    });
  }

  async readMethodsDoc(): Promise<string | null> {
    return this.wrap(async () => {
      const [exists] = await this.bucket.file(this.methodsPath).exists();
      if (!exists) return null;
      return (await this.download(this.methodsPath)).toString('utf8');
    });
  }

  // One bucket list + one small manifest download per committed day. A day is
  // benchmarkable iff its manifest was committed AND all three artifacts the
  // manifest promises are present — a partial day is an issue, never a day.
  private async scanDays(): Promise<{ listings: DayListing[]; issues: DayIssue[]; names: Set<string> }> {
    return this.wrap(async () => {
      const [objects] = await this.bucket.getFiles({ prefix: ES_STORAGE_PREFIX });
      const names = new Set(objects.map((o) => o.name));
      const listings: DayListing[] = [];
      const issues: DayIssue[] = [];
      for (const name of names) {
        const m = /^knowledge-base\/es\/(\d{8})\/manifest\.json$/.exec(name);
        if (!m) continue;
        const day = m[1];
        let recapDate: string;
        try {
          recapDate = (JSON.parse((await this.download(name)).toString('utf8')) as { recapDate: string }).recapDate;
          if (!/^\d{8}$/.test(recapDate)) throw new Error(`bad recapDate ${recapDate}`);
        } catch (err) {
          issues.push({ day, missing: [`unreadable manifest: ${(err as Error).message}`] });
          continue;
        }
        const paths = dayPaths(day, recapDate);
        const missing = [paths.tradePlanMd, paths.tradePlanPdf, paths.recap].filter((p) => !names.has(p));
        if (missing.length) {
          issues.push({ day, missing });
          continue;
        }
        listings.push({ day, date: `${day.slice(4, 8)}-${day.slice(0, 2)}-${day.slice(2, 4)}`, prefix: day, recapDate });
      }
      listings.sort((a, b) => a.date.localeCompare(b.date));
      issues.sort((a, b) => a.day.localeCompare(b.day));
      return { listings, issues, names };
    });
  }

  async collectDays(): Promise<DayListing[]> {
    return (await this.scanDays()).listings;
  }

  async collectDayIssues(): Promise<DayIssue[]> {
    return (await this.scanDays()).issues;
  }

  async loadDay(listing: DayListing): Promise<DayInput> {
    return this.wrap(async () => {
      const paths = dayPaths(listing.day, listing.recapDate);
      const [pdf, tp, recap] = await Promise.all([
        this.download(paths.tradePlanPdf),
        this.download(paths.tradePlanMd),
        this.download(paths.recap),
      ]);
      return {
        ...listing,
        pdf,
        tpTranscript: tp.toString('utf8'),
        recapTranscript: recap.toString('utf8'),
        recapFileName: `${listing.recapDate}_ES_RECAP.md`,
      };
    });
  }

  async priorCompleteDays(targetDay: string): Promise<DayListing[]> {
    const days = await this.collectDays();
    const targetDate = `${targetDay.slice(4, 8)}-${targetDay.slice(0, 2)}-${targetDay.slice(2, 4)}`;
    return days.filter((d) => d.date < targetDate);
  }

  // A day's OUTCOME recap is `<day>_ES_RECAP.md`, physically located in the
  // FOLLOWING day's folder — scan the whole prefix for that filename.
  async outcomeRecapForDay(day: string): Promise<string | null> {
    const { names } = await this.scanDays();
    const target = [...names].find((n) => n.endsWith(`/${day}_ES_RECAP.md`));
    return target ? (await this.download(target)).toString('utf8') : null;
  }
```

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/benchmark/cloud-inputs.service.spec.ts` — expected: PASS (both describes).

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/cloud-inputs.service.ts src/benchmark/cloud-inputs.service.spec.ts
git commit -m "feat(benchmark): CloudInputsService bucket half (days, general, methods, recaps)"
```

---

### Task 3: Drift findings gain a `source` field

**Files:**
- Modify: `src/benchmark/drift.ts`
- Modify: `src/benchmark/drift.spec.ts` (exists — extend)

**Interfaces:**
- Produces: `DriftFinding.source: 'firestore' | 'bucket'` — `'bucket'` for family `general`, `'firestore'` for `persona` / `feature` / `staticDoc`. `GENERAL_IDENTITY` stays `'knowledge-base/general'`.

- [ ] **Step 1: Add a failing assertion** to the existing drift spec: any persona-family finding has `source: 'firestore'`; any general-family finding has `source: 'bucket'`. Locate an existing test that produces a `file-drift` finding per family and extend its expectation, e.g.:

```ts
expect(finding).toMatchObject({ family: 'persona', source: 'firestore' });
// and for the general-docs case:
expect(finding).toMatchObject({ family: 'general', source: 'bucket' });
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/drift.spec.ts` — expected: FAIL (no `source` property).

- [ ] **Step 3: Implement** — in `drift.ts`: add `source: 'firestore' | 'bucket'` to `DriftFinding`; where findings are constructed (the `compare` helper), derive it:

```ts
const sourceFor = (family: DriftFamily): 'firestore' | 'bucket' => (family === 'general' ? 'bucket' : 'firestore');
```

and set `source: sourceFor(family)` on every finding. In `renderDrift`, include it in the per-finding line (e.g. `` `${f.family} ${f.identity} [${f.source}]` `` appended to the existing wording — keep the remedy sentences unchanged). Also update the local-file wording in the `DriftKind` doc comment (`file on disk` → `stored content`).

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/benchmark/drift.spec.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/drift.ts src/benchmark/drift.spec.ts
git commit -m "feat(benchmark): drift findings name their source store"
```

---

### Task 4: Migrate SevenKeysService to CloudInputsService

**Files:**
- Modify: `src/benchmark/seven-keys/seven-keys.service.ts`
- Modify: `src/benchmark/seven-keys/seven-keys.service.spec.ts`
- Modify: `src/benchmark/seven-keys/seven-keys.spec.ts` (if it constructs the service)

**Interfaces:**
- Consumes: `CloudInputsService`, `DayInput` (content-bearing) from `../cloud-inputs.service`.
- Produces: `generate(day: DayInput)`, `ensureKeys(day: DayInput, opts?)` — signatures unchanged except `DayInput` now carries content; `computeInputsHash` becomes `private async computeInputsHash(day: DayInput): Promise<string>`.

- [ ] **Step 1: Update the spec's fixtures** — replace path-bearing fake days and any `readFileSync` mocking with content-bearing days and an async inputs fake:

```ts
const day: DayInput = {
  day: '07012026', date: '2026-07-01', prefix: '07012026', recapDate: '06302026',
  pdf: Buffer.from('PDF'), tpTranscript: 'PLAN', recapTranscript: 'RECAP',
  recapFileName: '06302026_ES_RECAP.md',
};
const inputs = {
  readMethodsDoc: jest.fn(async () => 'METHODS'),
  collectGeneralDocs: jest.fn(async () => ({ files: [], concatenated: 'GEN', sha256: 'g' })),
  priorCompleteDays: jest.fn(async () => []),
  outcomeRecapForDay: jest.fn(async () => null),
};
```

Every existing behavioral assertion stays; only the plumbing changes. Where the spec previously wrote temp files for `computeInputsHash`, assert the hash over `day.pdf`/`day.tpTranscript`/`day.recapTranscript` bytes instead (same `\x00`-separated scheme).

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/seven-keys/seven-keys.service.spec.ts` — expected: FAIL (type/shape errors).

- [ ] **Step 3: Implement the migration** in `seven-keys.service.ts`:
  - Replace `import { RepoInputsService, DayInput } from '../repo-inputs.service'` with `import { CloudInputsService, DayInput } from '../cloud-inputs.service'`; change the constructor param type. Delete `import { readFileSync } from 'node:fs'`.
  - In `generate()` (lines ~83–110): `const methodsDoc = await this.inputs.readMethodsDoc();` · `const general = await this.inputs.collectGeneralDocs();` · `const tpTranscript = day.tpTranscript;` · `const recapTranscript = day.recapTranscript;` · `const prior = await this.inputs.priorCompleteDays(day.day);` · in the lookback loop replace the two-step path read with `const outcomeRecap = await this.inputs.outcomeRecapForDay(p.day);` and pass `outcomeRecap` directly.
  - `computeInputsHash` (line ~278):

```ts
  private async computeInputsHash(day: DayInput): Promise<string> {
    const methods = (await this.inputs.readMethodsDoc()) ?? '';
    return createHash('sha256')
      .update(day.pdf).update('\x00')
      .update(day.tpTranscript).update('\x00')
      .update(day.recapTranscript).update('\x00')
      .update(methods)
      .digest('hex');
  }
```

  - In `ensureKeys` (line ~231): `const inputsHash = await this.computeInputsHash(day);`

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/benchmark/seven-keys/seven-keys.service.spec.ts src/benchmark/seven-keys/seven-keys.spec.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/seven-keys/
git commit -m "refactor(benchmark): seven-keys reads day content from cloud inputs"
```

---

### Task 5: Migrate remaining consumers; delete RepoInputsService

**Files:**
- Modify: `src/benchmark/benchmark.service.ts`
- Modify: `src/benchmark/scoreboard.service.ts`
- Modify: `src/benchmark/cache-warmer.ts`
- Modify: `src/benchmark/benchmark.module.ts`
- Delete: `src/benchmark/repo-inputs.service.ts`, `src/benchmark/repo-inputs.service.spec.ts`
- Modify: `src/benchmark/benchmark.service.spec.ts`, `src/benchmark/scoreboard.service.spec.ts`, `src/benchmark/cache-warmer.spec.ts`
- Modify: `src/config/configuration.ts` (remove `benchmark.repoRoot`) and `src/config/configuration.spec.ts`

**Interfaces:**
- Consumes: everything Tasks 1–2 produced.
- Produces: `BenchmarkService.run` refuses on empty traders/features with `UnprocessableEntityException`; `assembleDay(day: DayInput)` reads content fields.

- [ ] **Step 1: Update the three consumer specs** to async inputs fakes (same idiom as Task 4 Step 1: each `collect*` method a `jest.fn(async () => ...)`), and add two new failing tests to `benchmark.service.spec.ts`:

```ts
it('refuses to run with zero traders', async () => {
  inputs.collectTraders.mockResolvedValue([]);
  await expect(service.run({})).rejects.toThrow(/no traders/i);
});
it('refuses to run with zero features', async () => {
  inputs.collectFeatures.mockResolvedValue([]);
  await expect(service.run({})).rejects.toThrow(/no features/i);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --runTestsByPath src/benchmark/benchmark.service.spec.ts src/benchmark/scoreboard.service.spec.ts src/benchmark/cache-warmer.spec.ts` — expected: FAIL.

- [ ] **Step 3: Migrate `benchmark.service.ts`:**
  - Imports: swap `RepoInputsService, DayInput, TraderInput, FeatureInput` to `CloudInputsService, DayListing, DayInput, TraderInput, FeatureInput` from `./cloud-inputs.service`; delete the `node:fs` import; add `UnprocessableEntityException` to the `@nestjs/common` import.
  - Constructor: `private readonly inputs: CloudInputsService`.
  - `checkDrift()` (line 75): 

```ts
  async checkDrift(): Promise<DriftReport> {
    const [traders, features, general] = await Promise.all([
      this.inputs.collectTraders(),
      this.inputs.collectFeatures(),
      this.inputs.collectGeneralDocs(),
    ]);
    return detectDrift(this.driftInputs(traders, features, general.sha256), await this.repo.listCellsForDrift());
  }
```

  - `run()` (lines 90–115): await the three collects; then the refusal guard immediately after:

```ts
    const traders = await this.inputs.collectTraders();
    const features = await this.inputs.collectFeatures();
    const general = await this.inputs.collectGeneralDocs();
    if (!traders.length) throw new UnprocessableEntityException('no traders in Firestore — create personas via POST /traders before running');
    if (!features.length) throw new UnprocessableEntityException('no features in Firestore — create variants via POST /features before running');
```

  - `let days = await this.inputs.collectDays();` and `let issues = await this.inputs.collectDayIssues();` — `days` is `DayListing[]`; the cell-matrix loop only reads `day.day`/`day.date`, unchanged.
  - Inside the per-day `try` (after the coverage check passes, line ~184, before `assembleDay`): `const dayInput = await this.inputs.loadDay(day);` then `const bundle = await this.assembleDay(dayInput);` and `this.sevenKeys.ensureKeys(dayInput, ...)`.
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

- [ ] **Step 4: Migrate `scoreboard.service.ts`** — swap the import/constructor type; line 18-19 become:

```ts
    const traders = (await this.inputs.collectTraders()).map((t) => ({ name: t.name, origin: t.origin, mutation: t.mutation }));
    const features = (await this.inputs.collectFeatures()).map((f) => ({ id: f.id, name: f.name }));
```

- [ ] **Step 5: Migrate `cache-warmer.ts`** — swap the import/constructor type; lines 53-55 become:

```ts
    const general = (await this.inputs.collectGeneralDocs()).concatenated;
    const traders = new Map((await this.inputs.collectTraders()).map((t) => [t.name, t]));
    const features = new Map((await this.inputs.collectFeatures()).map((f) => [f.id, f]));
```

- [ ] **Step 6: Rewire `benchmark.module.ts`** — replace `RepoInputsService` import/provider with `CloudInputsService`. Delete `src/benchmark/repo-inputs.service.ts` and `src/benchmark/repo-inputs.service.spec.ts` (`git rm`). Remove `repoRoot` from `src/config/configuration.ts` (`benchmark.repoRoot` and the `BENCHMARK_REPO_ROOT` env read, plus the `resolve`/path import if now unused) and its assertions in `configuration.spec.ts`.

- [ ] **Step 7: Run the full unit suite** — `pnpm test` — expected: PASS everywhere except the two e2e-adjacent suites addressed in Task 7 (unit suites must be green; if any other suite still references `repo-inputs.service`, fix its import to the new service with the async fake idiom).

- [ ] **Step 8: Commit**

```bash
git add -A src/benchmark src/config
git commit -m "refactor(benchmark): all input consumers read from cloud stores; drop RepoInputsService"
```

---

### Task 6: Content write endpoints (ContentModule)

**Files:**
- Create: `src/content/content.module.ts`, `src/content/content.service.ts`, `src/content/content.controller.ts`
- Create: `src/content/content.service.spec.ts`, `src/content/content.controller.spec.ts`
- Modify: `src/app.module.ts` (add `ContentModule` to imports)

**Interfaces:**
- Consumes: `FIRESTORE`, `STORAGE_BUCKET`; `parseFrontmatter` from `src/common/markdown-frontmatter`; `TRADERS_COLLECTION`, `FEATURES_COLLECTION` from `src/benchmark/cloud-inputs.service`.
- Produces HTTP surface:
  - `POST /traders` `{ content: string }` → 201 `{ name, sha256 }`; 400 missing `name`/`origin`/`mutation` frontmatter or invalid name; 409 exists
  - `POST /features` `{ content: string, staticDocContent?: string }` → 201 `{ id, sha256 }`; 400 missing `id` frontmatter; 409 exists
  - `PUT /knowledge/general/:name` `{ content: string }` → 200 `{ path, sha256 }`; 400 invalid `:name`
  - `PUT /knowledge/methods` `{ content: string }` → 200 `{ path, sha256 }`
  - `GET /traders` → `[{ name, origin, mutation, sha256 }]`; `GET /features` → `[{ id, name, sha256 }]`; `GET /knowledge/general` → `[{ path, sha256 }]`

- [ ] **Step 1: Write failing service specs**

```ts
// src/content/content.service.spec.ts
import { ContentService } from './content.service';
import { ConflictException, BadRequestException } from '@nestjs/common';

const TRADER_MD = '---\nname: context-trader\norigin: seed\nmutation: none\n---\nbody';

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
    }),
    getFiles: ({ prefix }: { prefix: string }) =>
      Promise.resolve([Object.keys(saved).filter((n) => n.startsWith(prefix)).map((name) => ({ name }))]),
  } as any;
}

describe('ContentService', () => {
  it('createTrader validates lineage frontmatter and is write-once', async () => {
    const db = fakeDb();
    const svc = new ContentService(db, fakeBucket());
    const res = await svc.createTrader(TRADER_MD);
    expect(res.name).toBe('context-trader');
    expect(db.created['traders/context-trader'].content).toBe(TRADER_MD);
    await expect(svc.createTrader(TRADER_MD)).rejects.toThrow(ConflictException);
    await expect(svc.createTrader('---\nname: x\n---\nno lineage')).rejects.toThrow(BadRequestException);
    await expect(svc.createTrader('no frontmatter at all')).rejects.toThrow(BadRequestException);
  });

  it('createFeature requires id frontmatter, stores staticDocContent, write-once', async () => {
    const svc = new ContentService(fakeDb(), fakeBucket());
    const md = '---\nid: seven-keys-method\nname: Seven Keys\n---\nblock';
    const res = await svc.createFeature(md, 'METHOD DOC');
    expect(res.id).toBe('seven-keys-method');
    await expect(svc.createFeature(md)).rejects.toThrow(ConflictException);
    await expect(svc.createFeature('---\nname: no-id\n---\nx')).rejects.toThrow(BadRequestException);
  });

  it('putGeneral writes to the general prefix and rejects path-escaping names', async () => {
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
import { TRADERS_COLLECTION, FEATURES_COLLECTION } from '../benchmark/cloud-inputs.service';

const NAME_RE = /^[A-Za-z0-9_-]+$/; // doubles as a path-traversal guard for bucket keys
const GENERAL_PREFIX = 'knowledge-base/general/';
const METHODS_PATH = 'knowledge-base/methods/seven-keys.md';

interface WritableBucketLike {
  file(path: string): { save(content: string, opts?: object): Promise<unknown> | unknown };
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
        throw new ConflictException(`${collection}/${id} already exists — content is write-once; create a new ${collection === TRADERS_COLLECTION ? 'persona' : 'feature'} instead`);
      }
      throw err;
    }
  }

  async createTrader(content: string): Promise<{ name: string; sha256: string }> {
    const fm = parseFrontmatter(content);
    const missing = ['name', 'origin', 'mutation'].filter((k) => !(k in fm));
    if (missing.length) {
      throw new BadRequestException(`persona frontmatter must declare: ${missing.join(', ')} (the scoreboard family tree depends on lineage fields)`);
    }
    if (!NAME_RE.test(fm.name)) throw new BadRequestException(`invalid persona name: ${fm.name}`);
    const sha256 = this.sha256(content);
    await this.createOnce(TRADERS_COLLECTION, fm.name, { name: fm.name, content, sha256, createdAt: new Date().toISOString() });
    return { name: fm.name, sha256 };
  }

  async createFeature(content: string, staticDocContent?: string): Promise<{ id: string; sha256: string }> {
    const fm = parseFrontmatter(content);
    if (!fm.id) throw new BadRequestException('feature frontmatter must declare: id');
    if (!NAME_RE.test(fm.id)) throw new BadRequestException(`invalid feature id: ${fm.id}`);
    const sha256 = this.sha256(content);
    await this.createOnce(FEATURES_COLLECTION, fm.id, {
      id: fm.id,
      content,
      staticDocContent: staticDocContent ?? null,
      sha256,
      createdAt: new Date().toISOString(),
    });
    return { id: fm.id, sha256 };
  }

  async putGeneral(name: string, content: string): Promise<{ path: string; sha256: string }> {
    if (!NAME_RE.test(name)) throw new BadRequestException(`invalid general-doc name: ${name}`);
    const path = `${GENERAL_PREFIX}${name}.md`;
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

  async listGeneral(): Promise<{ path: string }[]> {
    const [objects] = await this.bucket.getFiles({ prefix: GENERAL_PREFIX });
    return objects.map((o) => ({ path: o.name })).sort((a, b) => a.path.localeCompare(b.path));
  }
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm test -- --runTestsByPath src/content/content.service.spec.ts` — expected: PASS.

- [ ] **Step 5: Controller + module + wiring.** Controller spec (`content.controller.spec.ts`): instantiate the controller with a jest-mocked service and assert each route method delegates (`createTrader` called with `body.content`, etc.) — follow the delegation-spec idiom in `src/benchmark/benchmark.controller.ts`'s spec if one exists, else keep it to direct method calls.

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
  createFeature(@Body() body: { content?: string; staticDocContent?: string }) {
    return this.content.createFeature(this.requireContent(body), body.staticDocContent);
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

Add `ContentModule` to `src/app.module.ts` imports (alongside `BenchmarkModule` etc.).

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
- Consumes: `fakeFirestore()` from `test/fake-firestore.ts` (already supports write-once `create()`); the suites' local `fakeBucket()`.

- [ ] **Step 1: Extend each suite's `fakeBucket()`** with `getFiles` (the new listing surface):

```ts
    getFiles: ({ prefix }: { prefix: string }) =>
      Promise.resolve([Object.keys(saved).filter((n) => n.startsWith(prefix)).map((name) => ({ name }))] as [
        { name: string }[],
      ]),
```

- [ ] **Step 2: Replace `seedRepo()` (filesystem) with cloud seeding.** Delete the `mkdtempSync`/`BENCHMARK_REPO_ROOT` machinery (`node:fs`, `node:os`, `node:path` imports included) and seed the fakes instead, before app init:

```ts
function seedCloud(db: ReturnType<typeof fakeFirestore>, bucket: ReturnType<typeof fakeBucket>) {
  db.collection('traders').doc('context-trader').set({
    name: 'context-trader',
    content: '---\nname: context-trader\norigin: seed\nmutation: none\n---\nbody',
  });
  db.collection('features').doc('seven-keys-scorecard').set({
    id: 'seven-keys-scorecard',
    content: '---\nid: seven-keys-scorecard\nname: Seven Keys Scorecard\nartifactSuffix: _ES_KEYS.md\n---\nblock',
    staticDocContent: 'METHOD',
  });
  bucket.saved['knowledge-base/general/g.md'] = Buffer.from('GEN');
  bucket.saved['knowledge-base/methods/seven-keys.md'] = Buffer.from('METHODS');
  bucket.saved['knowledge-base/es/07012026/manifest.json'] = Buffer.from(JSON.stringify({ date: '07012026', recapDate: '06302026' }));
  bucket.saved['knowledge-base/es/07012026/07012026_ES_TP.pdf'] = Buffer.from('PDF');
  bucket.saved['knowledge-base/es/07012026/07012026_ES_TP.md'] = Buffer.from('PLAN');
  bucket.saved['knowledge-base/es/07012026/06302026_ES_RECAP.md'] = Buffer.from('RECAP');
}
```

Adjust to each suite's actual seeded traders/features/days — keep the *same* content strings the old `seedRepo` wrote so hash-based assertions (e.g. the drift-guard e2e case at `test/benchmark.e2e-spec.ts:282`) keep their meaning; where a spec asserted against a persona hash, the content is unchanged so the hash is unchanged. Replace `RepoInputsService` imports/overrides with `CloudInputsService` if the suite referenced the provider directly.

- [ ] **Step 3: Run** — `pnpm test:e2e -- --runTestsByPath test/benchmark.e2e-spec.ts test/benchmark-scorecard.e2e-spec.ts` — expected: PASS. Then the full suites: `pnpm test && pnpm test:e2e` — expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test(e2e): benchmark suites seed cloud fakes instead of a temp repo"
```

---

### Task 8: One-time content migration + verification gate

No code files — this task runs against the local backend (`pnpm start` in `backend/`, ADC configured) and is the acceptance gate. Run from the **repo root**.

- [ ] **Step 1: Import the two personas** (still on disk):

```bash
jq -Rs '{content: .}' traders/context-trader.md    | curl -sf -X POST localhost:3000/traders  -H 'content-type: application/json' -d @-
jq -Rs '{content: .}' traders/context-structured.md | curl -sf -X POST localhost:3000/traders  -H 'content-type: application/json' -d @-
```

- [ ] **Step 2: Import the two features** (from git history; `staticDocContent` for the method feature comes from its old `staticDoc` target — check the frontmatter of the recovered file for the exact path, expected `features/seven-keys-method.md` → `knowledge-base/methods/seven-keys.md`):

```bash
git show HEAD~1:features/seven-keys-scorecard.md | jq -Rs '{content: .}' | curl -sf -X POST localhost:3000/features -H 'content-type: application/json' -d @-
STATIC=$(git show HEAD~1:knowledge-base/methods/seven-keys.md | jq -Rs .)
git show HEAD~1:features/seven-keys-method.md | jq -Rs --argjson sd "$STATIC" '{content: ., staticDocContent: $sd}' | curl -sf -X POST localhost:3000/features -H 'content-type: application/json' -d @-
```

(Use `git log --oneline -- features/` to find the last commit that still has the files if `HEAD~1` has moved; the deletions are uncommitted at plan time, so `HEAD` itself should work.)

- [ ] **Step 3: Upload the shared docs:**

```bash
git show HEAD:knowledge-base/general/support_and_resistance_zones.md | jq -Rs '{content: .}' | curl -sf -X PUT localhost:3000/knowledge/general/support_and_resistance_zones -H 'content-type: application/json' -d @-
git show HEAD:knowledge-base/methods/seven-keys.md | jq -Rs '{content: .}' | curl -sf -X PUT localhost:3000/knowledge/methods -H 'content-type: application/json' -d @-
```

- [ ] **Step 4: Verify — the acceptance gate:**

```bash
curl -s localhost:3000/benchmark/drift
```

Expected: `{"findings":[],"cellsExamined":476}` (findings MUST be empty — proves migrated content hashes match all 476 recorded cells). Also sanity-check listings: `curl -s localhost:3000/traders` shows both personas with lineage; `curl -s localhost:3000/features` shows both features.

- [ ] **Step 5:** If drift is non-empty, STOP — diff the imported content against what a recorded cell expects (`sampleCells` in the finding) before touching anything else. The most likely cause is trailing-newline mangling in shell piping; `jq -Rs` preserves bytes, so compare `git show` output hashes with `shasum -a 256` against the `currentSha256` in the finding.

---

### Task 9: Repo cleanup + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (repo root)
- Delete (commit the pending deletions + newly-migrated files): `knowledge-base/`, `features/`, `traders/`, `.claude/skills/ingest-ticker-data/`, `.claude/skills/seven-keys/`, `.claude/skills/trader-bench/`, `.claude/skills/trader-panel/`, `.claude/skills/trader-spawn/`

Only run this task after Task 8's gate passed.

- [ ] **Step 1: Stage the deletions** (from repo root):

```bash
git rm -r --quiet knowledge-base features traders .claude/skills/ingest-ticker-data .claude/skills/seven-keys .claude/skills/trader-bench .claude/skills/trader-panel .claude/skills/trader-spawn
```

Note: most are already deleted from disk (git status `D`); `git rm` stages them. `traders/` still exists on disk and is removed here — its content now lives in Firestore (verified in Task 8).

- [ ] **Step 2: Update `CLAUDE.md`:**
  - "Use the API, not the skills" section: drop the sentence about skills being "kept only as reference documentation" (they're deleted); state content lives in Firebase Storage/Firestore.
  - "Trader personas" section: rewrite to — personas are **write-once Firestore docs** created via `POST /traders` (frontmatter must declare `name`/`origin`/`mutation`); refining a persona means a new name, never an edit; `GET /traders` lists them; the persona set in Firestore is the only source of truth.
  - Benchmark section: note day availability comes from committed eminiplayer manifests in the bucket (`POST /eminiplayer/ingest` is how a day becomes benchmarkable); document `POST /features`, `PUT /knowledge/general/:name`, `PUT /knowledge/methods`, and the three GET listings under a short "Content endpoints" heading.
  - Remove any remaining reference to `knowledge-base/` as a local directory or to `.claude/skills/trader-spawn/SKILL.md` documenting conventions.

- [ ] **Step 3: Final verification** — `cd backend && pnpm test && pnpm test:e2e` — expected: PASS. `curl -s localhost:3000/benchmark/drift` — still `{}` findings.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: retire local knowledge base — Firebase Storage/Firestore are the source of truth"
```

---

## Self-review notes

- Spec coverage: storage layout (T1/T2/T6), CloudInputsService interface incl. lazy `loadDay` (T2/T5), consumer migration (T4/T5), drift `source` (T3), write endpoints + validation + write-once (T6), error handling — 503 wrap (T1), day issues (T2), zero-input refusal (T5) — e2e migration (T7), one-time migration + drift gate (T8), cleanup + CLAUDE.md (T9).
- The spec's `collectDays(): Promise<DayListing[]>` + separate `loadDay` is implemented as `loadDay(listing)` (taking the listing, not the day string) — callers all hold a listing, and it avoids a second manifest fetch.
- `DayListing` gains `recapDate` (internal necessity for `loadDay`); `DayInput` gains `recapFileName` (needed by `assembleDay`'s `ensureTranscript` call). Both are supersets of the spec shapes.
