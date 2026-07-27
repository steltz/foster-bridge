# Seven-Keys Generation + Scorecard Variant Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the four-agent seven-keys generation workflow into the NestJS backend as a sequential Anthropic-API chain on Fable, store the verified KEYS scorecard in Firestore, and wire the `seven-keys-scorecard` benchmark variant to consume it so the bench can measure `Δ(scorecard) − Δ(method)`.

**Architecture:** A new `SevenKeysService` (added to the existing `BenchmarkModule`) runs `current-day ∥ lookback → synthesize → verify` as four single structured-output calls on Fable via a new `AnthropicService.messageStructured`, persists the verified KEYS markdown to `dayArtifacts/{day}__keys`, and exposes an idempotent `ensureKeys(day)` that freezes a day's KEYS once stored. `BenchmarkService.run` walks days oldest-first, calls `ensureKeys` after the candle/coverage skip and before batching, substitutes `${DOC}` (methods) + `${ARTIFACT}` (KEYS) into the scorecard feature tier via `EnvelopeBuilder`, and threads `artifactSha256` through `CellMeta` into each persisted scorecard cell. The vendored `computeFeatureImpact` surfaces the scorecard delta automatically once cells exist.

**Tech Stack:** NestJS 10, TypeScript, @anthropic-ai/sdk 0.115.0, Firebase Admin (Firestore + Storage), @nestjs/schedule, Jest.

---

## Files created/modified

| Path | Action | Task |
|---|---|---|
| `backend/src/benchmark/benchmark.types.ts` | Modify — `SCORECARD_VARIANT`, `ALL_VARIANTS`, `BenchmarkCell.artifactSha256?` | 1 |
| `backend/src/benchmark/benchmark.types.spec.ts` | Modify — new variant-const + cell field tests | 1 |
| `backend/src/benchmark/benchmark.repository.ts` | Modify — `CellMeta.artifactSha256?`, `DayArtifactDoc` provenance fields | 1 |
| `backend/src/benchmark/benchmark.repository.spec.ts` | Modify — provenance round-trip test | 1 |
| `backend/src/anthropic/anthropic.service.ts` | Modify — add `messageStructured` | 2 |
| `backend/src/anthropic/anthropic.service.spec.ts` | Modify — `messageStructured` describe block | 2 |
| `backend/src/benchmark/repo-inputs.service.ts` | Modify — `FeatureInput.artifactSuffix`, `priorCompleteDays`, `outcomeRecapPathForDay` | 3 |
| `backend/src/benchmark/repo-inputs.service.spec.ts` | Modify — artifactSuffix + lookback-helper tests | 3 |
| `backend/src/benchmark/seven-keys/schemas.ts` | Create | 4 |
| `backend/src/benchmark/seven-keys/prompts.ts` | Create | 4 |
| `backend/src/benchmark/seven-keys/seven-keys.spec.ts` | Create — schemas + prompts | 4 |
| `backend/src/benchmark/seven-keys/seven-keys.service.ts` | Create | 5, 6 |
| `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts` | Create | 5, 6 |
| `backend/src/benchmark/envelope.builder.ts` | Modify — `${DOC}`/`${ARTIFACT}` scorecard substitution | 7 |
| `backend/src/benchmark/envelope.builder.spec.ts` | Modify — scorecard envelope tests | 7 |
| `backend/src/benchmark/benchmark.service.ts` | Modify — allow scorecard, call `ensureKeys`, thread `artifactSha256` | 8 |
| `backend/src/benchmark/benchmark.service.spec.ts` | Modify — SevenKeysService mock + scorecard tests | 8 |
| `backend/src/benchmark/batch-reconciler.ts` | Modify — persist `artifactSha256` in `buildCell` | 9 |
| `backend/src/benchmark/batch-reconciler.spec.ts` | Modify — artifactSha256 persistence test | 9 |
| `backend/src/benchmark/benchmark.module.ts` | Modify — provide `SevenKeysService` | 10 |
| `backend/test/benchmark-scorecard.e2e-spec.ts` | Create | 11 |

**Jest placement:** unit config has `rootDir: 'src'`, `testRegex: '.*\\.spec\\.ts$'`, so every `*.spec.ts` lives under `backend/src/` (including the new `src/benchmark/seven-keys/*.spec.ts`). The e2e config has `rootDir: '.'` (the `test/` dir), `testRegex: '.e2e-spec.ts$'`.

**Run commands:** unit `cd backend && pnpm test -- <pattern>`; e2e `cd backend && pnpm test:e2e -- <pattern>`; typecheck/boot `cd backend && pnpm build`.

**Design decisions baked into this plan (see report):**
- Ported JSON schemas DROP `maxLength` and `minItems` — the structured-outputs validator rejects `maxLength`/integer `minimum`/`maximum` (same rule that shaped `SETUP_SCHEMA`); `minItems` is dropped defensively. Only `type`/`enum`/`required`/`properties`/`items`/`additionalProperties` are sent.
- KEYS `content` = YAML frontmatter (`generatedBy`/`generatedAt`/`lookbackSources`/`verified`) + blank line + the synthesizer's artifact body — a faithful port of the skill's committed file, and exactly what `${ARTIFACT}` injects. Provenance is ALSO stored as optional top-level `DayArtifactDoc` fields.
- `artifactSha256` on a scorecard cell == the stored KEYS `contentHash` (sha256 of the injected content).
- `DayArtifactDoc.gcsPath` stays required; the `keys` doc sets a synthetic `benchmark/es/{day}/{prefix}_ES_KEYS.md` path (KEYS are stored inline via `content`, not byte-mirrored to GCS) so no `day-artifacts.service.ts` ripple.
- Freeze guard: a `seven-keys-scorecard` cell can only exist if the day's KEYS were already stored, so `ensureKeys`' "reuse when `dayArtifacts/{day}__keys` exists" IS the freeze — no separate cell-scan is needed.
- All four agents run on `claude-fable-5`; current-day is a distinct hard-pinned const.

---

### Task 1: Types + variant + provenance

**Files:**
- Modify: `backend/src/benchmark/benchmark.types.ts`
- Modify: `backend/src/benchmark/benchmark.types.spec.ts`
- Modify: `backend/src/benchmark/benchmark.repository.ts`
- Modify: `backend/src/benchmark/benchmark.repository.spec.ts`

- [ ] **Step: Write the failing type tests.**

In `backend/src/benchmark/benchmark.types.spec.ts`, update the import line and append two tests to the existing `describe('SETUP_SCHEMA / CORE_VARIANTS')` block (keep the existing `scopes core variants to base + seven-keys-method` test unchanged):

```ts
// change the existing import at the top of the file to add the new symbols:
import { cellKey, parseCellKey, SETUP_SCHEMA, CORE_VARIANTS, ALL_VARIANTS, SCORECARD_VARIANT, resolveModel } from './benchmark.types';
```

```ts
  it('keeps CORE_VARIANTS intact and adds scorecard only to ALL_VARIANTS', () => {
    expect(CORE_VARIANTS).toEqual(['base', 'seven-keys-method']);
    expect(SCORECARD_VARIANT).toBe('seven-keys-scorecard');
    expect(ALL_VARIANTS).toEqual(['base', 'seven-keys-method', 'seven-keys-scorecard']);
    // CORE_VARIANTS must NOT contain the scorecard variant (base/method-only callers rely on this).
    expect(CORE_VARIANTS).not.toContain('seven-keys-scorecard');
  });
```

In `backend/src/benchmark/benchmark.repository.spec.ts`, add a test asserting a `keys` artifact round-trips its provenance + inline content. First read the top of that file to match its existing `build()`/fake-firestore helper, then append inside the top-level describe:

```ts
  it('round-trips a keys DayArtifactDoc with inline content + provenance', async () => {
    const repo = await build(); // existing helper that wires BenchmarkRepository to the fake Firestore
    await repo.saveDayArtifact('07012026', 'keys', {
      contentHash: 'kh',
      gcsPath: 'benchmark/es/07012026/07012026_ES_KEYS.md',
      content: '---\nverified: true\n---\n\n# Seven Keys',
      uploadedAt: 't',
      generatedBy: 'claude-fable-5',
      generatedAt: 't',
      lookbackSources: ['06302026_ES_KEYS.md'],
      verified: true,
    });
    const got = await repo.getDayArtifact('07012026', 'keys');
    expect(got?.content).toContain('# Seven Keys');
    expect(got?.generatedBy).toBe('claude-fable-5');
    expect(got?.lookbackSources).toEqual(['06302026_ES_KEYS.md']);
    expect(got?.verified).toBe(true);
  });
```

> If `benchmark.repository.spec.ts` has no shared `build()` helper, mirror whatever construction the existing tests use (they already wire `BenchmarkRepository` to `fakeFirestore()`); the assertion body is unchanged.

- [ ] **Step: Run the tests — expect FAIL.**

```
cd backend && pnpm test -- benchmark.types.spec benchmark.repository.spec
```
Expected: FAIL (`ALL_VARIANTS`/`SCORECARD_VARIANT` undefined; `DayArtifactDoc` has no `generatedBy`).

- [ ] **Step: Implement the type changes.**

In `backend/src/benchmark/benchmark.types.ts`, replace the `CORE_VARIANTS` declaration block with:

```ts
export type Variant = string; // 'base' | 'seven-keys-method' | 'seven-keys-scorecard'
export const CORE_VARIANTS: readonly Variant[] = Object.freeze(['base', 'seven-keys-method']);
// Plan 2: the generated-artifact variant. Kept OUT of CORE_VARIANTS (base/method-only
// callers must not pick it up); ALL_VARIANTS is the full set the run accepts.
export const SCORECARD_VARIANT: Variant = 'seven-keys-scorecard';
export const ALL_VARIANTS: readonly Variant[] = Object.freeze([...CORE_VARIANTS, SCORECARD_VARIANT]);
```

In the same file, add `artifactSha256?` to `BenchmarkCell` (after `staticDocSha256?`):

```ts
  featureSha256?: string; // omitted for base
  staticDocSha256?: string; // omitted when the variant has no staticDoc
  artifactSha256?: string; // sha256 of the injected KEYS content (scorecard cells only)
```

In `backend/src/benchmark/benchmark.repository.ts`, add `artifactSha256?` to `CellMeta`:

```ts
export interface CellMeta {
  date: string; // YYYY-MM-DD
  personaSha256: string;
  generalSha256: string;
  featureSha256?: string; // omitted for base
  staticDocSha256?: string; // omitted when the variant has no staticDoc
  artifactSha256?: string; // sha256 of the KEYS content (scorecard cells only)
}
```

And extend `DayArtifactDoc` with optional provenance fields (append after `uploadedAt`):

```ts
export interface DayArtifactDoc {
  contentHash: string;
  gcsPath: string;
  anthropicFileId?: string; // pdfFile only
  content?: string; // transcripts / keys inline copy
  uploadedAt: string;
  // Seven-keys ('keys') provenance (Plan 2). The KEYS markdown in `content` also
  // carries a YAML-frontmatter copy of these (that is the injectable artifact); the
  // top-level fields make provenance queryable without parsing the markdown.
  generatedBy?: string;
  generatedAt?: string;
  lookbackSources?: string[];
  verified?: boolean;
}
```

- [ ] **Step: Run the tests — expect PASS.**

```
cd backend && pnpm test -- benchmark.types.spec benchmark.repository.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): add seven-keys-scorecard variant types and artifact provenance"
```

---

### Task 2: AnthropicService structured single-message

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts`
- Modify: `backend/src/anthropic/anthropic.service.spec.ts`

- [ ] **Step: Write the failing `messageStructured` tests.**

Append a new describe block INSIDE the outer `describe('AnthropicService', ...)` in `backend/src/anthropic/anthropic.service.spec.ts` (reuses the shared `create`/`betaCreate`/`service` fixtures already set up in `beforeEach`):

```ts
  describe('messageStructured', () => {
    const FILES_BETA = ['files-api-2025-04-14'];

    it('non-files: sends output_config.format and parses the JSON text', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"pass":true,"mismatches":[]}' }],
        usage: {},
      });
      const schema = { type: 'object', required: ['pass'] } as any;
      const out = await service.messageStructured<{ pass: boolean; mismatches: string[] }>(
        { prompt: 'verify' },
        { model: 'claude-fable-5', outputSchema: schema, effort: 'high' },
      );
      expect(betaCreate).not.toHaveBeenCalled();
      const arg = create.mock.calls[0][0];
      expect(arg.model).toBe('claude-fable-5');
      expect(arg.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'high' });
      expect(arg.messages).toEqual([{ role: 'user', content: 'verify' }]);
      expect(out).toEqual({ pass: true, mismatches: [] });
    });

    it('files:true routes to the beta client with the files beta header and a cached document tier', async () => {
      betaCreate.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"bias":"b"}' }],
        usage: {},
      });
      await service.messageStructured(
        { prompt: 'analyze' },
        {
          model: 'claude-fable-5',
          outputSchema: { type: 'object' } as any,
          files: true,
          context: { userTiers: [{ blocks: [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }] }] },
        },
      );
      expect(create).not.toHaveBeenCalled();
      const arg = betaCreate.mock.calls[0][0];
      expect(arg.betas).toEqual(FILES_BETA);
      // The document tier is cached (last-block breakpoint) and the prompt is appended uncached.
      expect(arg.messages[0].content[0]).toMatchObject({ type: 'document', source: { type: 'file', file_id: 'file_1' } });
      expect(arg.messages[0].content[arg.messages[0].content.length - 1]).toEqual({ type: 'text', text: 'analyze' });
    });

    it('throws when the model refuses (stop_reason refusal)', async () => {
      create.mockResolvedValue({ model: 'claude-fable-5', stop_reason: 'refusal', content: [], usage: {} });
      await expect(
        service.messageStructured({ prompt: 'x' }, { outputSchema: { type: 'object' } as any }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('throws a 502 when the structured output is not valid JSON', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not json' }],
        usage: {},
      });
      let caught: unknown;
      try {
        await service.messageStructured({ prompt: 'x' }, { outputSchema: { type: 'object' } as any });
      } catch (e) {
        caught = e;
      }
      expect((caught as HttpException).getStatus()).toBe(502);
    });
  });
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- anthropic.service.spec
```
Expected: FAIL (`service.messageStructured is not a function`).

- [ ] **Step: Implement `messageStructured`.**

In `backend/src/anthropic/anthropic.service.ts`, add this method to the `AnthropicService` class (place it after `message`, before `uploadFile`). It reuses `buildCachedRequest` for optional cached context and mirrors `createBatch`'s `output_config` shape.

```ts
  /**
   * One synchronous structured-output message (NOT a batch). Applies
   * output_config.format when an outputSchema is given, routes through the
   * beta/files client when `files` is set, reuses the cached-prefix builder for
   * an optional CachedContext, and returns the parsed JSON. A refusal throws.
   */
  async messageStructured<T = unknown>(
    input: { prompt: string; system?: string },
    opts?: {
      model?: string;
      outputSchema?: unknown;
      context?: CachedContext;
      files?: boolean;
      effort?: string;
      maxTokens?: number;
    },
  ): Promise<T> {
    const client = this.clientFactory.get();
    const model = opts?.model ?? this.defaultModel;
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;
    const files = opts?.files === true;
    const outputConfig = {
      ...(opts?.outputSchema ? { format: { type: 'json_schema', schema: opts.outputSchema } } : {}),
      ...(opts?.effort ? { effort: opts.effort } : {}),
    };
    const built = opts?.context
      ? this.buildCachedRequest(opts.context, input.prompt)
      : { messages: [{ role: 'user' as const, content: input.prompt }] };
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // System only when not already carried by the cached context.
      ...(input.system && !opts?.context ? { system: input.system } : {}),
      ...built,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };
    try {
      const resp = files
        ? await client.beta.messages.create({ ...params, betas: FILES_BETA } as any)
        : await client.messages.create(params as any);
      if (resp.stop_reason === 'refusal') {
        throw new HttpException(
          { statusCode: 422, error: 'Structured message refused' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      let text = '';
      for (const block of resp.content) {
        if (block.type === 'text') text += block.text;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpException(
          { statusCode: 502, error: 'Structured output was not valid JSON' },
          HttpStatus.BAD_GATEWAY,
        );
      }
    } catch (err) {
      this.rethrow(err);
    }
  }
```

- [ ] **Step: Run — expect PASS.**

```
cd backend && pnpm test -- anthropic.service.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(anthropic): add messageStructured for single structured-output calls"
```

---

### Task 3: RepoInputs — artifactSuffix + lookback/recap helpers

**Files:**
- Modify: `backend/src/benchmark/repo-inputs.service.ts`
- Modify: `backend/src/benchmark/repo-inputs.service.spec.ts`

- [ ] **Step: Write the failing tests.**

In `backend/src/benchmark/repo-inputs.service.spec.ts`, extend `seedFixture()` to add a scorecard feature and a three-day lookback chain. Add these lines inside `seedFixture()` (before `return dir;`), and note the recap-in-next-folder convention:

```ts
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
```

> The existing `07022026`/`07032026` fixture folders are intentionally incomplete/mismatched, so `collectDays` returns only `07012026`, `07082026`, `07092026` (chronological). Update the existing `collectDays returns only complete folders` test's length expectation accordingly:

```ts
  it('collectDays returns only complete folders with a derived YYYY-MM-DD date', async () => {
    const svc = await build(root);
    const days = svc.collectDays();
    expect(days.map((d) => d.day)).toEqual(['07012026', '07082026', '07092026']);
    expect(days[0]).toMatchObject({ day: '07012026', date: '2026-07-01', prefix: '07012026' });
    expect(days[0].pdfPath.endsWith('07012026_ES_TP.pdf')).toBe(true);
  });
```

Then append new tests to the `describe('RepoInputsService')` block:

```ts
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
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- repo-inputs.service.spec
```
Expected: FAIL (`artifactSuffix` undefined; `priorCompleteDays`/`outcomeRecapPathForDay` not functions).

- [ ] **Step: Implement the helpers + artifactSuffix.**

In `backend/src/benchmark/repo-inputs.service.ts`, add `artifactSuffix` to the `FeatureInput` interface:

```ts
export interface FeatureInput {
  id: string;
  name: string;
  file: string;
  block: string;
  sha256: string;
  staticDoc: string | null; // repo-relative path
  staticDocContent: string | null;
  staticDocSha256: string | null;
  artifactSuffix: string | null; // e.g. '_ES_KEYS.md' (scorecard); null when no artifact
}
```

In `collectFeatures`, read it from frontmatter and include it in the returned object:

```ts
        const staticDoc = fm.staticDoc || null;
        const artifactSuffix = fm.artifactSuffix || null;
        let staticDocContent: string | null = null;
        let staticDocSha256: string | null = null;
        if (staticDoc) {
          staticDocContent = readFileSync(join(this.root, staticDoc), 'utf8');
          staticDocSha256 = this.sha256(staticDocContent);
        }
        return {
          id,
          name: fm.name || id,
          file,
          block: this.extractBlock(content),
          sha256: this.sha256(content),
          staticDoc,
          staticDocContent,
          staticDocSha256,
          artifactSuffix,
        };
```

Add the two lookback helpers at the end of the class (after `readMethodsDoc`):

```ts
  // Complete days strictly BEFORE the target, chronological (oldest first). Reuses
  // collectDays (already complete-only + sorted asc by derived date).
  priorCompleteDays(targetDay: string): DayInput[] {
    const days = this.collectDays();
    const target = days.find((d) => d.day === targetDay);
    const targetDate =
      target?.date ?? `${targetDay.slice(4, 8)}-${targetDay.slice(0, 2)}-${targetDay.slice(2, 4)}`;
    return days.filter((d) => d.date < targetDate);
  }

  // A day's OUTCOME recap is `<day>_ES_RECAP.md` — named for the session it
  // describes and physically located in the FOLLOWING day's folder. Scan every
  // es/* folder for that filename; null when no later day recorded it yet.
  outcomeRecapPathForDay(day: string): string | null {
    const dir = join(this.root, 'knowledge-base', 'es');
    if (!existsSync(dir)) return null;
    const target = `${day}_ES_RECAP.md`;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(dir, entry.name);
      if (readdirSync(folder).includes(target)) return join(folder, target);
    }
    return null;
  }
```

- [ ] **Step: Run — expect PASS.**

```
cd backend && pnpm test -- repo-inputs.service.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): read artifactSuffix and add lookback disk helpers"
```

---

### Task 4: Seven-keys schemas + prompts (pure)

**Files:**
- Create: `backend/src/benchmark/seven-keys/schemas.ts`
- Create: `backend/src/benchmark/seven-keys/prompts.ts`
- Create: `backend/src/benchmark/seven-keys/seven-keys.spec.ts`

- [ ] **Step: Write the failing schema + prompt tests.**

Create `backend/src/benchmark/seven-keys/seven-keys.spec.ts`:

```ts
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';
import { currentDayPrompt, lookbackPrompt, synthesizePrompt, verifyPrompt } from './prompts';

describe('seven-keys schemas', () => {
  it('CURRENT_SCHEMA requires bias/environment/zones and grades zones on keys 3-7', () => {
    expect(CURRENT_SCHEMA.required).toEqual(['bias', 'environment', 'zones']);
    const zone = (CURRENT_SCHEMA.properties as any).zones.items;
    expect(zone.required).toEqual(['prices', 'side', 'key3', 'key4', 'key5', 'key6', 'key7', 'grade']);
    expect(zone.properties.grade.enum).toEqual(['automatic-fade', 'strong', 'moderate', 'weak']);
    expect(zone.properties.side.enum).toEqual(['support', 'resistance']);
  });

  it('drops structured-output-illegal constraints (maxLength / minItems)', () => {
    const zone = (CURRENT_SCHEMA.properties as any).zones;
    expect(zone.minItems).toBeUndefined();
    expect(zone.items.properties.prices.maxLength).toBeUndefined();
    expect((CURRENT_SCHEMA.properties as any).bias.maxLength).toBeUndefined();
  });

  it('LOOKBACK/SYNTH/VERIFY required fields', () => {
    expect(LOOKBACK_SCHEMA.required).toEqual(['calibration', 'continuity']);
    expect(SYNTH_SCHEMA.required).toEqual(['artifact']);
    expect(VERIFY_SCHEMA.required).toEqual(['pass', 'mismatches']);
  });
});

describe('seven-keys prompts', () => {
  it('currentDayPrompt inlines methods + transcripts and carries the grade-discrimination rule', () => {
    const p = currentDayPrompt({
      date: '2026-07-01',
      generalDocs: 'GEN',
      methodsDoc: 'METHODS',
      tpTranscript: 'TP',
      recapTranscript: 'RECAP',
    });
    expect(p).toContain('METHODS');
    expect(p).toContain('TP');
    expect(p).toContain('RECAP');
    expect(p).toContain('Copy each zone');
    expect(p).toContain('no more than about a third');
    expect(p).toContain('attached PDF');
  });

  it('lookbackPrompt lists days oldest-first and marks missing recaps', () => {
    const p = lookbackPrompt('2026-07-08', [
      { day: '07012026', keysContent: 'K1', outcomeRecap: 'O1' },
      { day: '07022026', keysContent: 'K2', outcomeRecap: null },
    ]);
    expect(p.indexOf('07012026')).toBeLessThan(p.indexOf('07022026'));
    expect(p).toContain('K1');
    expect(p).toContain('no outcome recap available');
  });

  it('synthesizePrompt embeds both inputs and the authoritative weighting rule', () => {
    const p = synthesizePrompt('2026-07-01', { bias: 'b' }, { calibration: [] }, '07012026_ES_KEYS.md');
    expect(p).toContain('"bias": "b"');
    expect(p).toContain('authoritative');
    expect(p).toContain('07012026_ES_KEYS.md');
    const boot = synthesizePrompt('2026-07-01', { bias: 'b' }, null, 'none — bootstrap');
    expect(boot).toContain('none — bootstrap');
  });

  it('verifyPrompt embeds the artifact and demands price+side fidelity only', () => {
    const p = verifyPrompt('2026-07-01', 'TP', '# ARTIFACT BODY');
    expect(p).toContain('# ARTIFACT BODY');
    expect(p).toContain('fidelity');
    expect(p).toContain('attached PDF');
  });
});
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- seven-keys/seven-keys.spec
```
Expected: FAIL (modules do not exist).

- [ ] **Step: Implement `schemas.ts`.**

Create `backend/src/benchmark/seven-keys/schemas.ts` (ported from the skill; `maxLength`/`minItems` removed because the structured-outputs validator rejects them):

```ts
// Ported from .claude/skills/seven-keys/SKILL.md. The structured-outputs validator
// rejects string `maxLength` and integer `minimum`/`maximum` (see SETUP_SCHEMA); we
// also drop array `minItems` defensively. Only type/enum/required/properties/items/
// additionalProperties are sent.

export const CURRENT_SCHEMA = {
  type: 'object',
  required: ['bias', 'environment', 'zones'],
  properties: {
    bias: { type: 'string' },
    environment: { type: 'string' },
    zones: {
      type: 'array',
      items: {
        type: 'object',
        required: ['prices', 'side', 'key3', 'key4', 'key5', 'key6', 'key7', 'grade'],
        properties: {
          prices: { type: 'string' },
          side: { enum: ['support', 'resistance'] },
          key3: { type: 'string' },
          key4: { type: 'string' },
          key5: { type: 'string' },
          key6: { type: 'string' },
          key7: { type: 'string' },
          grade: { enum: ['automatic-fade', 'strong', 'moderate', 'weak'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export const LOOKBACK_SCHEMA = {
  type: 'object',
  required: ['calibration', 'continuity'],
  properties: {
    calibration: {
      type: 'array',
      items: {
        type: 'object',
        required: ['day', 'verdict'],
        properties: { day: { type: 'string' }, verdict: { type: 'string' } },
        additionalProperties: false,
      },
    },
    continuity: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

export const SYNTH_SCHEMA = {
  type: 'object',
  required: ['artifact'],
  properties: { artifact: { type: 'string' } },
  additionalProperties: false,
} as const;

export const VERIFY_SCHEMA = {
  type: 'object',
  required: ['pass', 'mismatches'],
  properties: {
    pass: { type: 'boolean' },
    mismatches: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;
```

- [ ] **Step: Implement `prompts.ts`.**

Create `backend/src/benchmark/seven-keys/prompts.ts` (prompt intent ported verbatim from the skill; paths replaced by inlined content + an attached PDF, since the backend injects text and carries the PDF as a Files-beta document block):

```ts
export interface CurrentDayPromptInput {
  date: string;
  generalDocs: string; // concatenated general docs (may be '')
  methodsDoc: string;
  tpTranscript: string;
  recapTranscript: string;
}

export function currentDayPrompt(i: CurrentDayPromptInput): string {
  const generalBlock = i.generalDocs
    ? `First read ALL of these general trading-strategy documents — session-agnostic context for how zones are built and traded:\n\n${i.generalDocs}\n\n`
    : '';
  return `You are the current-day Seven-Keys zone analyst for the ${i.date} ES (E-mini S&P 500) session.

${generalBlock}The trade plan worksheet (support/resistance zones) is provided as an attached PDF document. Also use these two session documents:

Trade plan video transcript:
${i.tpTranscript}

Prior-session recap transcript:
${i.recapTranscript}

Seven-Keys methodology (defines the keys you grade against):
${i.methodsDoc}

Keys 1-2 (expectancy; no price confirmation) are trader behaviors and are NOT your job. Assess EVERY support/resistance zone in the trade plan against Keys 3-7:
- key3: the likely approach into the zone (exhaustion, first test vs retest)
- key4: the zone's timeframe significance
- key5: whether a significant prior move launched from it
- key6: alignment with the larger-timeframe bias
- key7: confluence — how many keys stack here

Copy each zone's prices EXACTLY as the trade plan states them (e.g. "7495.25-7502.75") — never round, invent, or merge zones. Grade each zone automatic-fade | strong | moderate | weak, where automatic-fade means several keys stack so strongly that intraday price action gets no weight. The grade is a same-day filter, not an abstract quality ranking: factor in whether the zone can realistically be tested this session — a zone with excellent larger-timeframe pedigree that sits beyond any plausible single-session move grades moderate at best, with the pedigree recorded in its key4/key5 cells rather than the grade. Grades must discriminate at the top: strong and automatic-fade together should mark only the few zones a trader should prioritize today — no more than about a third of the sheet — and moderate is a deliberate middle call, not a default bucket; it is fine for many distant zones to collapse into weak. Also state the day's larger-timeframe bias and any environment/volatility notes.`;
}

export interface LookbackEntry {
  day: string;
  keysContent: string;
  outcomeRecap: string | null;
}

export function lookbackPrompt(date: string, entries: LookbackEntry[]): string {
  const blocks = entries
    .map(
      (e) =>
        `Day ${e.day} assessment:\n${e.keysContent}\n\n${
          e.outcomeRecap
            ? `Day ${e.day} outcome recap:\n${e.outcomeRecap}`
            : `Day ${e.day}: no outcome recap available.`
        }`,
    )
    .join('\n\n---\n\n');
  return `You are the lookback calibration analyst for the ${date} ES session. Read each prior day's Seven-Keys assessment together with the recap that describes how that day's session ACTUALLY traded:

${blocks}

For each prior day, judge from its outcome recap whether the highly graded zones actually held — flag grades that proved wrong, do not smooth them over (one calibration entry per prior day). Then note continuity: zones recurring across days, bias evolution, and anything that should sharpen today's assessment. You are advisory: today's analyst outranks you.`;
}

export function synthesizePrompt(
  date: string,
  current: unknown,
  lookback: unknown | null,
  sources: string,
): string {
  return `You are the synthesizer producing the ${date} ES Seven-Keys artifact. Do not read any files. Your two inputs:

CURRENT-DAY ANALYSIS (authoritative):
${JSON.stringify(current, null, 2)}

LOOKBACK NOTES (advisory):
${lookback ? JSON.stringify(lookback, null, 2) : 'none — bootstrap'}

Weighting rule: the current-day analysis is authoritative. The lookback may sharpen wording, add calibration history, or annotate — it must NEVER change a zone's prices, add or drop zones, or override a current-day grade unless the current-day evidence itself is ambiguous. Keep every zone's prices EXACTLY as given.

Return the artifact as markdown in exactly this shape (no frontmatter — it is added later):

# Seven Keys — ES ${date}

**Larger-timeframe bias:** <one or two sentences>
**Environment notes:** <one or two sentences>

Keys 1-2 (expectancy; no price confirmation) are trader-behavior keys and remain the responsibility of each persona. Zones below are scored on Keys 3-7.

## Zone scorecard (Keys 3-7)

| Zone (prices) | Side | Key 3 approach | Key 4 timeframe | Key 5 prior launch | Key 6 bias align | Key 7 confluence | Grade |
|---|---|---|---|---|---|---|---|
<one row per zone, cells terse, side values lowercase (support/resistance)>

## Automatic-fade candidates

<bullet list of zones graded automatic-fade, or "- None today.">

## Lookback

Sources: ${sources}

<calibration-aware bullets, including any prior grades that proved wrong, or "- none — bootstrap">`;
}

export function verifyPrompt(date: string, tpTranscript: string, artifact: string): string {
  return `You are a fidelity verifier for the ${date} ES session. The trade plan worksheet is provided as an attached PDF document. Also use the trade plan video transcript:

${tpTranscript}

Below is a synthesized Seven-Keys scorecard. Check EVERY row of its zone table against those documents: the zone's prices and side (support/resistance) must match a zone actually present in the trade plan — no invented zones, no dropped-then-substituted zones, no transposed or rounded prices. Do NOT judge grades, bias, or wording — fidelity to the source zones only. Return pass=true only if every row checks out; otherwise pass=false with one mismatch string per problem row.

ARTIFACT:
${artifact}`;
}
```

- [ ] **Step: Run — expect PASS.**

```
cd backend && pnpm test -- seven-keys/seven-keys.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): add ported seven-keys schemas and prompt builders"
```

---

### Task 5: SevenKeysService.generate(day)

**Files:**
- Create: `backend/src/benchmark/seven-keys/seven-keys.service.ts`
- Create: `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts`

- [ ] **Step: Write the failing `generate` tests.**

Create `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts`:

```ts
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync: jest.fn() }));

import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { SevenKeysService } from './seven-keys.service';
import { BenchmarkRepository } from '../benchmark.repository';
import { RepoInputsService } from '../repo-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { AnthropicService } from '../../anthropic/anthropic.service';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';

const DAY = {
  day: '07082026',
  date: '2026-07-08',
  prefix: '07082026',
  pdfPath: '/es/07082026/07082026_ES_TP.pdf',
  planPath: '/es/07082026/07082026_ES_TP.md',
  recapPath: '/es/07082026/07012026_ES_RECAP.md',
};

// messageStructured stub: canned output keyed on the schema's required fields.
function structuredFor(schema: any) {
  const req: string[] = schema.required;
  if (req.includes('zones'))
    return { bias: 'b', environment: 'e', zones: [{ prices: '7500-7510', side: 'support', key3: 'a', key4: 'b', key5: 'c', key6: 'd', key7: 'e', grade: 'strong' }] };
  if (req.includes('calibration')) return { calibration: [{ day: '07012026', verdict: 'held' }], continuity: ['x'] };
  if (req.includes('artifact')) return { artifact: '# Seven Keys — ES 2026-07-08\n\n| row |' };
  if (req.includes('pass')) return { pass: true, mismatches: [] };
  return {};
}

function makeDeps() {
  const anthropic = { messageStructured: jest.fn(async (_i: any, opts: any) => structuredFor(opts.outputSchema)) };
  const repo = { getDayArtifact: jest.fn().mockResolvedValue(null), saveDayArtifact: jest.fn().mockResolvedValue(undefined) };
  const inputs = {
    collectGeneralDocs: jest.fn().mockReturnValue({ concatenated: 'GEN', sha256: 'g' }),
    readMethodsDoc: jest.fn().mockReturnValue('METHODS'),
    priorCompleteDays: jest.fn().mockReturnValue([]),
    outcomeRecapPathForDay: jest.fn().mockReturnValue(null),
  };
  const dayArtifacts = { ensureFileId: jest.fn().mockResolvedValue('file_1') };
  return { anthropic, repo, inputs, dayArtifacts };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SevenKeysService,
      { provide: AnthropicService, useValue: deps.anthropic },
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: RepoInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'benchmark.effort' ? 'high' : undefined) } },
    ],
  }).compile();
  return moduleRef.get(SevenKeysService);
}

describe('SevenKeysService.generate', () => {
  beforeEach(() => {
    (readFileSync as jest.Mock).mockImplementation((p: string) => (String(p).includes('RECAP') ? 'RECAP' : 'TP'));
  });

  it('bootstrap: skips the lookback agent and runs current(pinned fable) -> synth -> verify', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    const schemas = deps.anthropic.messageStructured.mock.calls.map((c) => c[1].outputSchema);
    expect(schemas).toContain(CURRENT_SCHEMA);
    expect(schemas).toContain(SYNTH_SCHEMA);
    expect(schemas).toContain(VERIFY_SCHEMA);
    expect(schemas).not.toContain(LOOKBACK_SCHEMA); // no prior KEYS -> bootstrap
    // Current-day is explicitly pinned to Fable and carries the PDF (files:true).
    const currentCall = deps.anthropic.messageStructured.mock.calls.find((c) => c[1].outputSchema === CURRENT_SCHEMA)!;
    expect(currentCall[1].model).toBe('claude-fable-5');
    expect(currentCall[1].files).toBe(true);
    expect(out).toEqual({ verified: true, mismatches: [], artifact: '# Seven Keys — ES 2026-07-08\n\n| row |', lookbackSources: [] });
  });

  it('runs the lookback agent oldest-first when prior KEYS exist, and reports sources oldest-first', async () => {
    const deps = makeDeps();
    deps.inputs.priorCompleteDays.mockReturnValue([
      { day: '07012026', date: '2026-07-01' },
      { day: '07022026', date: '2026-07-02' },
    ]);
    deps.repo.getDayArtifact.mockImplementation(async (d: string, kind: string) =>
      kind === 'keys' ? { content: `KEYS-${d}` } : null,
    );
    deps.inputs.outcomeRecapPathForDay.mockReturnValue('/es/next/x_ES_RECAP.md');
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    const lookbackCall = deps.anthropic.messageStructured.mock.calls.find((c) => c[1].outputSchema === LOOKBACK_SCHEMA)!;
    expect(lookbackCall[0].prompt.indexOf('07012026')).toBeLessThan(lookbackCall[0].prompt.indexOf('07022026'));
    expect(out.lookbackSources).toEqual(['07012026_ES_KEYS.md', '07022026_ES_KEYS.md']);
  });

  it('caps the lookback set to the 3 most recent prior KEYS days (still oldest-first)', async () => {
    const deps = makeDeps();
    deps.inputs.priorCompleteDays.mockReturnValue(
      ['07012026', '07022026', '07032026', '07042026'].map((day) => ({ day, date: `2026-07-0${day[1]}` })),
    );
    deps.repo.getDayArtifact.mockImplementation(async (d: string, kind: string) => (kind === 'keys' ? { content: `K-${d}` } : null));
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(out.lookbackSources).toEqual(['07022026_ES_KEYS.md', '07032026_ES_KEYS.md', '07042026_ES_KEYS.md']);
  });

  it('verifier fail -> verified:false with mismatches, no persistence attempted here', async () => {
    const deps = makeDeps();
    deps.anthropic.messageStructured.mockImplementation(async (_i: any, opts: any) =>
      opts.outputSchema === VERIFY_SCHEMA ? { pass: false, mismatches: ['invented 7999'] } : structuredFor(opts.outputSchema),
    );
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(out.verified).toBe(false);
    expect(out.mismatches).toEqual(['invented 7999']);
  });

  it('verify runs after synth and embeds the synthesized artifact', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.generate(DAY as any);
    const calls = deps.anthropic.messageStructured.mock.calls;
    const synthIdx = calls.findIndex((c) => c[1].outputSchema === SYNTH_SCHEMA);
    const verifyIdx = calls.findIndex((c) => c[1].outputSchema === VERIFY_SCHEMA);
    expect(synthIdx).toBeLessThan(verifyIdx);
    expect(calls[verifyIdx][0].prompt).toContain('# Seven Keys — ES 2026-07-08');
  });
});
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- seven-keys/seven-keys.service.spec
```
Expected: FAIL (`SevenKeysService` does not exist).

- [ ] **Step: Implement `seven-keys.service.ts` (`generate` only for now; `ensureKeys` added in Task 6).**

Create `backend/src/benchmark/seven-keys/seven-keys.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AnthropicService, CachedContext } from '../../anthropic/anthropic.service';
import { BenchmarkRepository, DayArtifactDoc } from '../benchmark.repository';
import { RepoInputsService, DayInput } from '../repo-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';
import { currentDayPrompt, lookbackPrompt, synthesizePrompt, verifyPrompt, LookbackEntry } from './prompts';

// All four agents run on Fable; the current-day analyst is a distinct hard pin
// (a blind comparison found it more methodology-faithful than Sonnet for grading).
const SEVEN_KEYS_MODEL = 'claude-fable-5';
const CURRENT_DAY_MODEL = 'claude-fable-5';

export interface KeysArtifact {
  verified: boolean;
  artifact: string; // synthesizer markdown body (no frontmatter)
  mismatches: string[];
  lookbackSources: string[]; // '<day>_ES_KEYS.md', oldest-first (or [])
}

@Injectable()
export class SevenKeysService {
  private readonly logger = new Logger(SevenKeysService.name);

  constructor(
    private readonly anthropic: AnthropicService,
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly config: ConfigService,
  ) {}

  private get effort(): string {
    return this.config.get<string>('benchmark.effort') ?? 'high';
  }

  private pdfContext(fileId: string): CachedContext {
    return { userTiers: [{ blocks: [{ type: 'document', source: { type: 'file', file_id: fileId } } as any] }] };
  }

  /** Runs current-day ∥ lookback -> synthesize -> verify on Fable. Never persists. */
  async generate(day: DayInput): Promise<KeysArtifact> {
    const methodsDoc = this.inputs.readMethodsDoc();
    if (!methodsDoc) throw new Error(`Seven-keys methods doc missing (day ${day.day})`);
    const general = this.inputs.collectGeneralDocs();
    const tpTranscript = readFileSync(day.planPath, 'utf8');
    const recapTranscript = readFileSync(day.recapPath, 'utf8');
    const fileId = await this.dayArtifacts.ensureFileId(day.day);

    // Lookback set: up-to-3 most recent prior complete days that already have KEYS,
    // oldest-first. Oldest-first generation upstream guarantees they exist.
    const prior = this.inputs.priorCompleteDays(day.day);
    const withKeys: LookbackEntry[] = [];
    for (const p of prior) {
      const doc = await this.repo.getDayArtifact(p.day, 'keys');
      if (!doc?.content) continue;
      const recapPath = this.inputs.outcomeRecapPathForDay(p.day);
      withKeys.push({
        day: p.day,
        keysContent: doc.content,
        outcomeRecap: recapPath ? readFileSync(recapPath, 'utf8') : null,
      });
    }
    const lookbackSet = withKeys.slice(-3); // 3 most recent, still oldest-first
    const lookbackSources = lookbackSet.map((l) => `${l.day}_ES_KEYS.md`);

    const currentPromise = this.anthropic.messageStructured<Record<string, unknown>>(
      { prompt: currentDayPrompt({ date: day.date, generalDocs: general.concatenated, methodsDoc, tpTranscript, recapTranscript }) },
      { model: CURRENT_DAY_MODEL, outputSchema: CURRENT_SCHEMA, files: true, effort: this.effort, context: this.pdfContext(fileId) },
    );
    const lookbackPromise: Promise<Record<string, unknown> | null> = lookbackSet.length
      ? this.anthropic.messageStructured<Record<string, unknown>>(
          { prompt: lookbackPrompt(day.date, lookbackSet) },
          { model: SEVEN_KEYS_MODEL, outputSchema: LOOKBACK_SCHEMA, effort: this.effort },
        )
      : Promise.resolve(null);
    const [current, lookback] = await Promise.all([currentPromise, lookbackPromise]);

    const sources = lookbackSet.length ? lookbackSources.join(' · ') : 'none — bootstrap';
    const synth = await this.anthropic.messageStructured<{ artifact: string }>(
      { prompt: synthesizePrompt(day.date, current, lookback, sources) },
      { model: SEVEN_KEYS_MODEL, outputSchema: SYNTH_SCHEMA, effort: this.effort },
    );

    const verdict = await this.anthropic.messageStructured<{ pass: boolean; mismatches: string[] }>(
      { prompt: verifyPrompt(day.date, tpTranscript, synth.artifact) },
      { model: SEVEN_KEYS_MODEL, outputSchema: VERIFY_SCHEMA, files: true, effort: this.effort, context: this.pdfContext(fileId) },
    );

    return { verified: verdict.pass, mismatches: verdict.mismatches, artifact: synth.artifact, lookbackSources };
  }
}
```

> `DayArtifactDoc` and `createHash` are imported now because Task 6 uses them; keep the imports.

- [ ] **Step: Run — expect PASS.**

```
cd backend && pnpm test -- seven-keys/seven-keys.service.spec
```
Expected: PASS (the `ensureKeys` tests are added in Task 6).

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): add SevenKeysService four-agent generation chain"
```

---

### Task 6: SevenKeysService.ensureKeys(day)

**Files:**
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.ts`
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts`

- [ ] **Step: Write the failing `ensureKeys` tests.**

Append to `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts`:

```ts
describe('SevenKeysService.ensureKeys', () => {
  it('reuses the stored KEYS when present and never regenerates (freeze)', async () => {
    const deps = makeDeps();
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true } as any;
    deps.repo.getDayArtifact.mockImplementation(async (_d: string, kind: string) => (kind === 'keys' ? existing : null));
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    const out = await svc.ensureKeys(DAY as any);
    expect(out).toBe(existing);
    expect(genSpy).not.toHaveBeenCalled(); // frozen: a benchmarked day always has stored KEYS
  });

  it('generates + persists a verified artifact with frontmatter provenance', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({
      verified: true,
      artifact: '# Seven Keys — ES 2026-07-08\n\n| row |',
      mismatches: [],
      lookbackSources: ['07012026_ES_KEYS.md'],
    });
    const out = await svc.ensureKeys(DAY as any);
    expect(deps.repo.saveDayArtifact).toHaveBeenCalledWith('07082026', 'keys', expect.objectContaining({
      generatedBy: 'claude-fable-5',
      verified: true,
      lookbackSources: ['07012026_ES_KEYS.md'],
    }));
    const doc = deps.repo.saveDayArtifact.mock.calls[0][2];
    expect(doc.content).toContain('generatedBy: claude-fable-5');
    expect(doc.content).toContain('lookbackSources: [07012026_ES_KEYS.md]');
    expect(doc.content).toContain('# Seven Keys — ES 2026-07-08');
    expect(doc.contentHash).toHaveLength(64);
    expect(out).toBe(doc);
  });

  it('returns null and does NOT persist when the verifier fails', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: false, artifact: 'x', mismatches: ['bad'], lookbackSources: [] });
    const out = await svc.ensureKeys(DAY as any);
    expect(out).toBeNull();
    expect(deps.repo.saveDayArtifact).not.toHaveBeenCalled();
  });

  it('returns null and does NOT persist when generation throws (e.g. Fable refusal)', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockRejectedValue(new Error('refused'));
    const out = await svc.ensureKeys(DAY as any);
    expect(out).toBeNull();
    expect(deps.repo.saveDayArtifact).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- seven-keys/seven-keys.service.spec
```
Expected: FAIL (`ensureKeys` not a function).

- [ ] **Step: Implement `ensureKeys` + KEYS composition.**

Add these methods to `SevenKeysService` in `backend/src/benchmark/seven-keys/seven-keys.service.ts` (after `generate`):

```ts
  /**
   * Idempotent: reuse the stored KEYS when present (a benchmarked day always has
   * one -> frozen, never regenerated); otherwise generate + verify + persist.
   * Returns the persisted doc, or null (logged) when the verifier/generation fails
   * so the caller skips the scorecard variant for the day.
   */
  async ensureKeys(day: DayInput): Promise<DayArtifactDoc | null> {
    const existing = await this.repo.getDayArtifact(day.day, 'keys');
    if (existing) return existing; // reuse == freeze (scorecard cells imply stored KEYS)

    let result: KeysArtifact;
    try {
      result = await this.generate(day);
    } catch (err) {
      this.logger.error(`Seven-keys generation failed for ${day.day}: ${(err as Error).message}`);
      return null;
    }
    if (!result.verified) {
      this.logger.warn(`Seven-keys verifier failed for ${day.day}: ${result.mismatches.join('; ')}`);
      return null;
    }
    const generatedAt = new Date().toISOString();
    const content = this.composeKeysMarkdown(result.artifact, generatedAt, result.lookbackSources);
    const doc: DayArtifactDoc = {
      contentHash: createHash('sha256').update(content).digest('hex'),
      gcsPath: `benchmark/es/${day.day}/${day.prefix}_ES_KEYS.md`, // inline-stored; path is a stable marker
      content,
      uploadedAt: generatedAt,
      generatedBy: CURRENT_DAY_MODEL,
      generatedAt,
      lookbackSources: result.lookbackSources,
      verified: true,
    };
    await this.repo.saveDayArtifact(day.day, 'keys', doc);
    return doc;
  }

  // Faithful port of the skill's committed KEYS file: YAML frontmatter + body.
  private composeKeysMarkdown(artifactBody: string, generatedAt: string, lookbackSources: string[]): string {
    return [
      '---',
      `generatedBy: ${CURRENT_DAY_MODEL}`,
      `generatedAt: ${generatedAt}`,
      `lookbackSources: [${lookbackSources.join(', ')}]`,
      'verified: true',
      '---',
      '',
      artifactBody.trim(),
      '',
    ].join('\n');
  }
```

- [ ] **Step: Run — expect PASS.**

```
cd backend && pnpm test -- seven-keys/seven-keys.service.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): add idempotent ensureKeys with freeze guard"
```

---

### Task 7: EnvelopeBuilder scorecard substitution

**Files:**
- Modify: `backend/src/benchmark/envelope.builder.ts`
- Modify: `backend/src/benchmark/envelope.builder.spec.ts`

- [ ] **Step: Write the failing scorecard-envelope tests.**

Append to `describe('EnvelopeBuilder', ...)` in `backend/src/benchmark/envelope.builder.spec.ts`:

```ts
  it('scorecard envelope substitutes ${DOC} + ${ARTIFACT} into the feature tier (still 4 tiers)', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-scorecard',
      featureBlock: 'Read ${DOC} then adopt ${ARTIFACT}.',
      methodsDoc: 'METHODS BODY',
      artifact: 'KEYS BODY',
    });
    expect(env.userTiers).toHaveLength(4);
    const feat = (env.userTiers![3].blocks[0] as any).text;
    expect(feat).toContain('METHODS BODY');
    expect(feat).toContain('KEYS BODY');
    expect(feat).not.toContain('${DOC}');
    expect(feat).not.toContain('${ARTIFACT}');
  });

  it('scorecard leading tiers stay byte-identical to dayBundleContext (prefix identity)', () => {
    const dayBundle = builder.dayBundleContext('GENERAL', bundle);
    const full = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-scorecard',
      featureBlock: 'Read ${DOC} then ${ARTIFACT}.',
      methodsDoc: 'M',
      artifact: 'K',
    });
    expect(full.userTiers!.slice(0, 2)).toEqual(dayBundle.userTiers);
  });

  it('throws when the scorecard variant has no artifact (empty feature-tier guard)', () => {
    expect(() =>
      builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
        variant: 'seven-keys-scorecard',
        featureBlock: 'Read ${DOC} then ${ARTIFACT}.',
        methodsDoc: 'M',
      }),
    ).toThrow(/seven-keys-scorecard.*artifact/i);
  });
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- envelope.builder.spec
```
Expected: FAIL (`artifact` not on `VariantSpec`; no substitution; no scorecard guard).

- [ ] **Step: Implement the scorecard substitution.**

In `backend/src/benchmark/envelope.builder.ts`, add `artifact?` to `VariantSpec`:

```ts
export interface VariantSpec {
  variant: Variant;
  featureBlock?: string; // the feature's prompt body (base: undefined)
  methodsDoc?: string; // seven-keys-method's staticDoc content
  artifact?: string; // seven-keys-scorecard's KEYS content (substituted into ${ARTIFACT})
}
```

Replace the `if (spec.variant !== 'base') { ... }` block inside `fullEnvelope` with a branch that substitutes placeholders for the scorecard variant and keeps the append behavior for other non-base variants:

```ts
    if (spec.variant === 'seven-keys-scorecard') {
      // Scorecard: substitute BOTH placeholders into the feature block. Use
      // split/join (not replace) to avoid regex `$` semantics on the content.
      if (spec.artifact == null || spec.artifact === '') {
        throw new Error(
          `Variant "${spec.variant}" requires a KEYS artifact to substitute into \${ARTIFACT}`,
        );
      }
      const featureText = (spec.featureBlock ?? '')
        .split('${DOC}')
        .join(spec.methodsDoc ?? '')
        .split('${ARTIFACT}')
        .join(spec.artifact)
        .trim();
      if (!featureText) {
        throw new Error(`Variant "${spec.variant}" produced an empty feature tier`);
      }
      tiers.push({ blocks: [{ type: 'text', text: featureText }] });
    } else if (spec.variant !== 'base') {
      const featureText = [spec.featureBlock ?? '', spec.methodsDoc ? `\n\n${spec.methodsDoc}` : '']
        .join('')
        .trim();
      if (!featureText) {
        throw new Error(
          `Non-base variant "${spec.variant}" requires a feature block or methods doc`,
        );
      }
      tiers.push({ blocks: [{ type: 'text', text: featureText }] });
    }
```

- [ ] **Step: Run — expect PASS (existing base/method tests unchanged).**

```
cd backend && pnpm test -- envelope.builder.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): substitute DOC and ARTIFACT for the scorecard envelope"
```

---

### Task 8: BenchmarkService scorecard integration

**Files:**
- Modify: `backend/src/benchmark/benchmark.service.ts`
- Modify: `backend/src/benchmark/benchmark.service.spec.ts`

- [ ] **Step: Write the failing scorecard-integration tests + wire the SevenKeysService mock.**

In `backend/src/benchmark/benchmark.service.spec.ts`:

1. Add the import and the mock to `makeDeps()` and `build()`. At the top imports add:

```ts
import { SevenKeysService } from './seven-keys/seven-keys.service';
```

2. In `makeDeps()`, add a `sevenKeys` mock (default: succeeds with a canned KEYS doc) and give `collectFeatures` the scorecard feature too:

```ts
  const sevenKeys = {
    ensureKeys: jest.fn().mockResolvedValue({ content: 'KEYS BODY', contentHash: 'ksha' }),
  };
```

Update the `inputs.collectFeatures` mock to include the scorecard feature alongside the method feature:

```ts
    collectFeatures: jest.fn().mockReturnValue([
      { id: 'seven-keys-method', name: 'm', file: 'seven-keys-method.md', block: 'Read ${DOC}.', sha256: 'fsha', staticDoc: 'knowledge-base/methods/seven-keys.md', staticDocContent: 'METHODS', staticDocSha256: 'dsha', artifactSuffix: null },
      { id: 'seven-keys-scorecard', name: 's', file: 'seven-keys-scorecard.md', block: 'Read ${DOC} then ${ARTIFACT}.', sha256: 'scsha', staticDoc: 'knowledge-base/methods/seven-keys.md', staticDocContent: 'METHODS', staticDocSha256: 'dsha', artifactSuffix: '_ES_KEYS.md' },
    ]),
```

Add `sevenKeys` to the returned object: `return { repo, inputs, dayArtifacts, anthropic, marketData, contracts, sevenKeys };`

3. In `build()`, add the provider:

```ts
      { provide: SevenKeysService, useValue: deps.sevenKeys },
```

4. Update the existing `restricts variants to the core set and warms both day-bundle and per-envelope` test. With the scorecard feature now present in the mock and the variant allowed, scorecard cells ARE produced; `ensureKeys` is called once for the candle-backed day. Replace that test body with:

```ts
  it('runs base + method + scorecard for a candle-backed day and generates KEYS once', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['base', 'seven-keys-method', 'seven-keys-scorecard'] });
    // KEYS generated once for the only candle-backed day (07012026).
    expect(deps.sevenKeys.ensureKeys).toHaveBeenCalledTimes(1);
    expect(deps.sevenKeys.ensureKeys.mock.calls[0][0].day).toBe('07012026');
    // 3 variants -> 3 full-envelope warms + 1 day-bundle warm.
    expect(deps.anthropic.warmCache).toHaveBeenCalledTimes(4);
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toEqual(
      expect.arrayContaining([
        'context-trader__fable__07012026__base__run1',
        'context-trader__fable__07012026__seven-keys-method__run1',
        'context-trader__fable__07012026__seven-keys-scorecard__run1',
      ]),
    );
  });
```

5. Append three new tests:

```ts
  it('generates KEYS oldest-first and threads artifactSha256 onto the scorecard cell', async () => {
    const deps = makeDeps();
    // Both days have candles + complete coverage so both do scorecard work.
    deps.marketData.getDay = jest.fn().mockResolvedValue([{ time: 1 }]);
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['seven-keys-scorecard'] });
    // collectDays is chronological asc, so ensureKeys is called 07012026 before 07022026.
    expect(deps.sevenKeys.ensureKeys.mock.calls.map((c) => c[0].day)).toEqual(['07012026', '07022026']);
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const meta = saved.customIdToCell['context-trader__fable__07012026__seven-keys-scorecard__run1'];
    expect(meta.artifactSha256).toBe('ksha');
    expect(meta.featureSha256).toBe('scsha');
  });

  it('skips ONLY the scorecard variant for a day when KEYS generation fails; base still runs', async () => {
    const deps = makeDeps();
    deps.sevenKeys.ensureKeys.mockResolvedValue(null); // verifier/generation failure
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base', 'seven-keys-scorecard'] });
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toContain('context-trader__fable__07012026__base__run1');
    expect(custIds).not.toContain('context-trader__fable__07012026__seven-keys-scorecard__run1');
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'keys generation failed' });
  });

  it('does NOT call ensureKeys when the scorecard variant is not requested', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['base'] });
    expect(deps.sevenKeys.ensureKeys).not.toHaveBeenCalled();
  });
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- benchmark.service.spec
```
Expected: FAIL (SevenKeysService is not a provider / scorecard not wired / `ensureKeys` never called).

- [ ] **Step: Implement the integration.**

In `backend/src/benchmark/benchmark.service.ts`:

1. Update the imports:

```ts
import { CORE_VARIANTS, ALL_VARIANTS, SCORECARD_VARIANT, resolveModel, cellKey, parseCellKey, SETUP_SCHEMA, Variant } from './benchmark.types';
import { SevenKeysService } from './seven-keys/seven-keys.service';
```

> `CORE_VARIANTS` may now be unused; drop it from the import if the linter/compiler flags it.

2. Add `SevenKeysService` to the constructor (place after `contracts`):

```ts
    private readonly contracts: ContractsService,
    private readonly sevenKeys: SevenKeysService,
    private readonly config: ConfigService,
```

3. Change the variant filter to accept the full set:

```ts
    const variants = (opts.variants ?? ALL_VARIANTS).filter((v) => ALL_VARIANTS.includes(v));
```

4. In the `dayCells` discovery loop, skip a non-base variant whose feature is missing (protects scorecard when no feature file exists). Replace the inner variant loop body's feature line + missing check:

```ts
        for (const variant of variants) {
          const feature = variant === 'base' ? undefined : featureById.get(variant);
          // A non-base variant with no matching feature file cannot build an
          // envelope — skip it rather than throwing later.
          if (variant !== 'base' && !feature) continue;
          const existing = await this.repo.existingRunIndices(trader.name, model.alias, day.day, variant);
          const already = queued.get(`${trader.name}|${model.alias}|${day.day}|${variant}`) ?? new Set<number>();
          const missing = Array.from({ length: runCount }, (_, i) => i + 1).filter(
            (n) => !existing.includes(n) && !already.has(n),
          );
          if (!missing.length) continue;
          dayCells.push({ trader, variant, feature, missing });
        }
```

5. Inside the per-day `try` block, AFTER `const bundle = await this.assembleDay(day);` and BEFORE building `requests`, generate KEYS for scorecard days (oldest-first is guaranteed by `collectDays` chronological ordering):

```ts
        // Seven-keys generation for the scorecard variant. assembleDay recorded the
        // PDF artifact, so ensureKeys can resolve a live file_id. Days are already
        // walked oldest-first (collectDays sorts asc), so a day's prior-KEYS
        // lookback dependency is generated before it is needed.
        let keysContent: string | undefined;
        let keysSha: string | undefined;
        if (dayCells.some((c) => c.variant === SCORECARD_VARIANT)) {
          const keysDoc = await this.sevenKeys.ensureKeys(day);
          if (!keysDoc) {
            summary.daysSkipped.push({ day: day.day, reason: 'keys generation failed' });
            // Drop ONLY the scorecard cells; base/method still run for this day.
            for (let i = dayCells.length - 1; i >= 0; i--) {
              if (dayCells[i].variant === SCORECARD_VARIANT) dayCells.splice(i, 1);
            }
            if (!dayCells.length) continue; // scorecard was the only work
          } else {
            keysContent = keysDoc.content;
            keysSha = keysDoc.contentHash;
          }
        }
```

6. In the request-building loop, pass the artifact into the envelope and thread `artifactSha256` into `CellMeta`:

```ts
          const envelope = this.envelopes.fullEnvelope(general.concatenated, bundle.dayBundle, trader.content, {
            variant,
            featureBlock: feature?.block,
            methodsDoc: feature?.staticDocContent ?? undefined,
            artifact: variant === SCORECARD_VARIANT ? keysContent : undefined,
          });
          enveloped.set(envKey, envelope);
          const meta: CellMeta = {
            date: day.date,
            personaSha256: trader.sha256,
            generalSha256: general.sha256,
            ...(feature ? { featureSha256: feature.sha256 } : {}),
            ...(feature?.staticDocSha256 ? { staticDocSha256: feature.staticDocSha256 } : {}),
            ...(variant === SCORECARD_VARIANT && keysSha ? { artifactSha256: keysSha } : {}),
          };
```

- [ ] **Step: Run — expect PASS.**

```
cd backend && pnpm test -- benchmark.service.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): generate and thread seven-keys into scorecard cells"
```

---

### Task 9: BatchReconciler persists artifactSha256

**Files:**
- Modify: `backend/src/benchmark/batch-reconciler.ts`
- Modify: `backend/src/benchmark/batch-reconciler.spec.ts`

- [ ] **Step: Write the failing persistence test.**

Append to `describe('BatchReconciler.reconcile', ...)` in `backend/src/benchmark/batch-reconciler.spec.ts`:

```ts
  it('persists artifactSha256 from CellMeta onto a scorecard cell', async () => {
    const deps = makeDeps();
    const SC_KEY = cellKey({ trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'seven-keys-scorecard', runIndex: 1 });
    deps.repo.nonTerminalBatches.mockResolvedValue([
      baseBatch({ customIdToCell: { [SC_KEY]: { ...META, featureSha256: 'scsha', staticDocSha256: 'dsha', artifactSha256: 'ksha' } } }),
    ]);
    deps.anthropic.getBatchResults.mockResolvedValue([
      { customId: SC_KEY, type: 'succeeded', text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }) },
    ]);
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.variant === 'seven-keys-scorecard');
    expect(cell.artifactSha256).toBe('ksha');
    expect(cell.featureSha256).toBe('scsha');
  });

  it('omits artifactSha256 on a base cell (no meta field)', async () => {
    const deps = makeDeps();
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.artifactSha256).toBeUndefined();
  });
```

- [ ] **Step: Run — expect FAIL.**

```
cd backend && pnpm test -- batch-reconciler.spec
```
Expected: FAIL (`cell.artifactSha256` is undefined on the scorecard cell).

- [ ] **Step: Implement.**

In `backend/src/benchmark/batch-reconciler.ts`, add `artifactSha256` to the `base` object in `buildCell` (after the `staticDocSha256` spread):

```ts
      ...(meta?.featureSha256 ? { featureSha256: meta.featureSha256 } : {}),
      ...(meta?.staticDocSha256 ? { staticDocSha256: meta.staticDocSha256 } : {}),
      ...(meta?.artifactSha256 ? { artifactSha256: meta.artifactSha256 } : {}),
      createdAt: new Date().toISOString(),
```

- [ ] **Step: Run — expect PASS.**

```
cd backend && pnpm test -- batch-reconciler.spec
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): persist artifactSha256 on scorecard cells"
```

---

### Task 10: SevenKeysModule wiring

**Files:**
- Modify: `backend/src/benchmark/benchmark.module.ts`

- [ ] **Step: Wire `SevenKeysService` into `BenchmarkModule`.**

`SevenKeysService` is consumed only by `BenchmarkService` and depends on providers already in this module (`BenchmarkRepository`, `RepoInputsService`, `DayArtifactsService`) plus the @Global `AnthropicService`/`ConfigService`. Add it to providers (no separate module needed). In `backend/src/benchmark/benchmark.module.ts`:

```ts
import { SevenKeysService } from './seven-keys/seven-keys.service';
```

and add `SevenKeysService` to the `providers` array (after `EnvelopeBuilder`):

```ts
  providers: [
    BenchmarkRepository,
    RepoInputsService,
    DayArtifactsService,
    EnvelopeBuilder,
    SevenKeysService,
    BenchmarkService,
    BatchReconciler,
    CacheWarmer,
    ScoreboardService,
  ],
```

- [ ] **Step: Boot + typecheck the whole backend — expect PASS.**

```
cd backend && pnpm build
```
Expected: PASS (no TS errors; DI graph resolves). Then run the full unit suite:

```
cd backend && pnpm test
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "feat(benchmark): wire SevenKeysService into BenchmarkModule"
```

---

### Task 11: e2e — seven-keys-scorecard run

**Files:**
- Create: `backend/test/benchmark-scorecard.e2e-spec.ts`

- [ ] **Step: Write the failing e2e.**

Create `backend/test/benchmark-scorecard.e2e-spec.ts`. The SDK is mocked so the four seven-keys agents (single `messages.create` calls carrying `output_config`) return canned JSON keyed on the schema's required fields, while the trade-decision batch returns a setup via `batches.results` (same as the core e2e). Assertions FAIL if KEYS are not stored or the scorecard cell is not persisted.

```ts
// The SDK mock must be declared before importing AppModule.
const setup = (side: string) =>
  JSON.stringify({ side, entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 });

// Seven-keys agents: canned structured output keyed on the schema's required fields.
function structuredFor(schema: any) {
  const req: string[] = schema?.required ?? [];
  if (req.includes('zones'))
    return { bias: 'b', environment: 'e', zones: [{ prices: '7500-7510', side: 'support', key3: 'a', key4: 'b', key5: 'c', key6: 'd', key7: 'e', grade: 'strong' }] };
  if (req.includes('calibration')) return { calibration: [], continuity: [] };
  if (req.includes('artifact')) return { artifact: '# Seven Keys — ES 2026-07-01\n\n## Zone scorecard (Keys 3-7)\n| 7500-7510 | support | a | b | c | d | e | strong |' };
  if (req.includes('pass')) return { pass: true, mismatches: [] };
  return {};
}

const batchState: { status: string } = { status: 'ended' };

class FakeAPIError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

jest.mock('@anthropic-ai/sdk', () => {
  // messages.create serves BOTH the max_tokens:0 cache warms (no output_config)
  // and the seven-keys structured calls (output_config.format.schema present).
  const messageCreate = jest.fn(async (params: any) => {
    const schema = params?.output_config?.format?.schema;
    if (schema) {
      return { model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(structuredFor(schema)) }], usage: {} };
    }
    return { model: 'claude-fable-5', stop_reason: 'end_turn', content: [], usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0 } };
  });
  const batchesCreate = jest.fn().mockResolvedValue({ id: 'batch_sc', processing_status: 'in_progress' });
  const batchesRetrieve = jest.fn(async () => ({ id: 'batch_sc', processing_status: batchState.status, request_counts: {} }));
  const batchesResults = jest.fn(async () => {
    async function* gen() {
      yield {
        custom_id: 'context-trader__fable__07012026__seven-keys-scorecard__run1',
        result: { type: 'succeeded', message: { stop_reason: 'end_turn', usage: { cache_read_input_tokens: 10 }, content: [{ type: 'text', text: setup('long') }] } },
      };
    }
    return gen();
  });
  const filesUpload = jest.fn().mockResolvedValue({ id: 'file_sc' });
  const batches = { create: batchesCreate, retrieve: batchesRetrieve, results: batchesResults };
  const ctor: any = function () {
    return {
      messages: { create: messageCreate, batches },
      beta: { messages: { create: messageCreate, batches }, files: { upload: filesUpload } },
    };
  };
  ctor.APIError = FakeAPIError;
  return { __esModule: true, default: ctor, toFile: jest.fn(async (bytes: Buffer, filename: string, o?: any) => ({ bytes, filename, type: o?.type })) };
});

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { FIRESTORE, STORAGE_BUCKET } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';
import { BatchReconciler } from '../src/benchmark/batch-reconciler';
import { ScoreboardService } from '../src/benchmark/scoreboard.service';
import { BenchmarkRepository } from '../src/benchmark/benchmark.repository';

function fakeBucket() {
  const saved: Record<string, Buffer> = {};
  return {
    saved,
    file: (path: string) => ({
      save: (b: Buffer) => { saved[path] = b; return Promise.resolve(); },
      exists: () => Promise.resolve([path in saved] as [boolean]),
      download: () => Promise.resolve([saved[path]] as [Buffer]),
    }),
  };
}

function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-sc-e2e-'));
  mkdirSync(join(dir, 'traders'), { recursive: true });
  writeFileSync(join(dir, 'traders', 'context-trader.md'), '---\nname: context-trader\n---\nbody');
  mkdirSync(join(dir, 'features'), { recursive: true });
  writeFileSync(
    join(dir, 'features', 'seven-keys-scorecard.md'),
    '---\nid: seven-keys-scorecard\nname: Seven-Keys precomputed scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\n---\nRead ${DOC} then adopt ${ARTIFACT}.',
  );
  mkdirSync(join(dir, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'methods', 'seven-keys.md'), 'METHODS DOC');
  mkdirSync(join(dir, 'knowledge-base', 'general'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'general', 'g.md'), 'GEN');
  const day = join(dir, 'knowledge-base', 'es', '07012026');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, '07012026_ES_TP.pdf'), 'PDF');
  writeFileSync(join(day, '07012026_ES_TP.md'), 'PLAN');
  writeFileSync(join(day, '06302026_ES_RECAP.md'), 'RECAP');
  return dir;
}

describe('Benchmark scorecard (e2e)', () => {
  let app: INestApplication;
  let repoRoot: string;
  const OPEN = Math.floor(Date.UTC(2026, 6, 1, 13, 30, 0) / 1000);
  const fullCsv = ['time,open,high,low,close', ...Array.from({ length: 78 }, (_, i) => `${OPEN + i * 300},100,120,90,110`)].join('\n');

  async function boot() {
    app = undefined as any;
    const db = fakeFirestore();
    process.env.BENCHMARK_REPO_ROOT = repoRoot;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE).useValue(db)
      .overrideProvider(STORAGE_BUCKET).useValue(fakeBucket())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return moduleRef;
  }

  beforeAll(() => { repoRoot = seedRepo(); });
  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.BENCHMARK_REPO_ROOT;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(async () => { if (app) await app.close(); });

  it('generates + stores KEYS, persists a scorecard cell with artifactSha256, and shows a scorecard group', async () => {
    batchState.status = 'ended';
    const moduleRef = await boot();
    await request(app.getHttpServer()).post('/markets/MES/min-5/candles').attach('file', Buffer.from(fullCsv), 'mes.csv').expect(201);

    const runRes = await request(app.getHttpServer())
      .post('/benchmark/run')
      .send({ model: 'fable', runCount: 1, variants: ['seven-keys-scorecard'] })
      .expect(201);
    expect(runRes.body.batchesSubmitted).toBe(1);
    expect(runRes.body.cellsQueued).toBe(1);

    const repo = moduleRef.get(BenchmarkRepository);

    // KEYS were generated + stored (capstone: this fails if generation did not persist).
    const keys = await repo.getDayArtifact('07012026', 'keys');
    expect(keys).not.toBeNull();
    expect(keys!.content).toContain('# Seven Keys — ES 2026-07-01');
    expect(keys!.verified).toBe(true);
    expect(keys!.contentHash).toHaveLength(64);

    await moduleRef.get(BatchReconciler).reconcile();

    // The scorecard cell persisted with a real backtest status + the KEYS hash.
    const cells = await repo.listCells('fable');
    expect(cells).toHaveLength(1);
    const cell = cells[0];
    expect(cell.variant).toBe('seven-keys-scorecard');
    expect(cell.result.status).toBe('SL'); // long entry 100 / SL 95 / TP 110 on flat 90-120 bars
    expect(cell.artifactSha256).toBe(keys!.contentHash);
    expect(cell.artifactSha256.length).toBeGreaterThan(0);

    // The scoreboard shows a scorecard group.
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('## context-trader @ fable [seven-keys-scorecard]');
    expect((sb.body.json as any).groups).toHaveLength(1);
    expect((sb.body.json as any).groups[0].variant).toBe('seven-keys-scorecard');
  });
});
```

- [ ] **Step: Run — expect FAIL first (if any wiring is incomplete), then PASS.**

```
cd backend && pnpm test:e2e -- benchmark-scorecard
```
Expected: PASS. Also re-run the full suites to confirm no regressions:

```
cd backend && pnpm test && pnpm test:e2e && pnpm build
```
Expected: PASS.

- [ ] **Step: Commit.**

```
git add -A && git commit -m "test(benchmark): e2e seven-keys-scorecard run"
```

---

## Self-review checklist (author-verified)

- Every §6 test target maps to a task: SevenKeysService chain/fail/reuse/freeze/oldest-first (Tasks 5–6); RepoInputs artifactSuffix + lookback/recap (Task 3); EnvelopeBuilder `${DOC}`+`${ARTIFACT}`/≤4 tiers/missing-artifact guard (Task 7); BenchmarkService oldest-first/skip-on-failure/artifactSha256 (Task 8); BatchReconciler artifactSha256 (Task 9); e2e (Task 11).
- Type/method-name consistency verified against merged code: `messageStructured` (new), `ensureKeys(day: DayInput)`/`generate(day: DayInput)`, `priorCompleteDays`/`outcomeRecapPathForDay`, `fullEnvelope(..., { variant, featureBlock?, methodsDoc?, artifact? })`, `CellMeta.artifactSha256?`, `BenchmarkCell.artifactSha256?`, `DayArtifactDoc` provenance fields, `SCORECARD_VARIANT`/`ALL_VARIANTS` (CORE_VARIANTS unchanged), `dayArtifacts/{day}__keys` via `getDayArtifact`/`saveDayArtifact`, `DayArtifactsService.ensureFileId`.
- No placeholders/TBD; all code blocks are complete (tests + impl); every task ends with a plain semantic commit, no attribution.
