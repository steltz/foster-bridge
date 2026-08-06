# EminiPlayer Playwright Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An injectable NestJS `EminiplayerService` that drives Playwright Chromium to log in to eminiplayer.net (when needed) and land on https://www.eminiplayer.net/archive.aspx, returning `{ url, title, screenshotPath }` as proof. No content parsing.

**Architecture:** New `backend/src/eminiplayer/` feature module with two providers: `PlaywrightService` (generic browser lifecycle — lazy Chromium launch, one shared context/page with all access serialized through `withPage()`, crash recovery, cleanup on module destroy) and `EminiplayerService` (site-specific login detection, login, navigation, verification, screenshot). Config via a new `eminiplayer` namespace in `configuration.ts`. Spec: `docs/superpowers/specs/2026-08-05-eminiplayer-playwright-module-design.md`.

**Tech Stack:** NestJS 10, `playwright` (Chromium only), `@nestjs/config`, Jest + ts-jest (unit tests with mocked Playwright — no live site hits in tests).

## Global Constraints

- All work happens in `backend/` (pnpm-managed; use `pnpm`, not npm — there is a `pnpm-lock.yaml`).
- Node >= 20, NestJS ^10.4.0, TypeScript ^5.5.0.
- Credentials only via env vars `EMINIPLAYER_USERNAME` / `EMINIPLAYER_PASSWORD` — never hardcoded, never committed. `.env` is already git-ignored.
- Tests: `*.spec.ts` next to source under `backend/src/` (jest `rootDir: 'src'`, `testRegex: '.*\.spec\.ts$'`). Run with `pnpm test` from `backend/`. E2E specs live in `backend/test/*.e2e-spec.ts` under a separate config and run only via `pnpm test:e2e`.
- Unit tests must never launch a real browser or hit the network.
- Semantic commit messages; no Claude attribution in commits.
- Site facts (verified 2026-08-05, login-signal amended 2026-08-06): `https://www.eminiplayer.net/archive.aspx` returns 200 when logged out. The logged-out signal is the nav anchor `a#ctl00_aLogin` WITHOUT `logoff` in its href — the nav reuses one shared anchor for both auth states ("Member Login" → `/login.aspx` logged out, "Log off" → `/login.aspx?logoff` logged in), and a members-only "Change password" link also points at `/login.aspx`, so an `a[href*="login.aspx"]` match reports logged-out forever (discovered during Task 4 live verification, commit 701a050). `backend/src/eminiplayer/eminiplayer.constants.ts` is the source of truth for these selectors. The login form at `https://www.eminiplayer.net/login.aspx` has inputs `#ctl00_cphBody_Login1_UserName`, `#ctl00_cphBody_Login1_Password`, submit `#ctl00_cphBody_Login1_LoginButton`.

---

### Task 1: Playwright dependency + `eminiplayer` config namespace

**Files:**
- Modify: `backend/package.json` (via pnpm)
- Modify: `backend/src/config/configuration.ts`
- Test: `backend/src/config/configuration.spec.ts` (append)
- Modify: `backend/.env.example`, `backend/.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppConfig.eminiplayer: { username?: string; password?: string; headless: boolean; screenshotDir: string }` read elsewhere via `ConfigService` keys `eminiplayer.username`, `eminiplayer.password`, `eminiplayer.headless`, `eminiplayer.screenshotDir`.

- [ ] **Step 1: Install playwright and its Chromium binary**

```bash
cd backend
pnpm add playwright
pnpm exec playwright install chromium
```

- [ ] **Step 2: Write the failing config tests**

Append to `backend/src/config/configuration.spec.ts` (top-level, after the existing describes; `configuration` is already imported at the top of the file):

```ts
describe('configuration (eminiplayer)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.EMINIPLAYER_USERNAME;
    delete process.env.EMINIPLAYER_PASSWORD;
    delete process.env.EMINIPLAYER_HEADLESS;
    delete process.env.EMINIPLAYER_SCREENSHOT_DIR;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults: creds undefined, headless true, screenshotDir anchored to backend/', () => {
    const cfg = configuration();
    expect(cfg.eminiplayer.username).toBeUndefined();
    expect(cfg.eminiplayer.password).toBeUndefined();
    expect(cfg.eminiplayer.headless).toBe(true);
    // Both this spec and configuration.ts live in src/config, so __dirname
    // resolves identically: backend/artifacts/eminiplayer.
    expect(cfg.eminiplayer.screenshotDir).toBe(
      resolve(__dirname, '..', '..', 'artifacts', 'eminiplayer'),
    );
  });

  it('reads env overrides and EMINIPLAYER_HEADLESS=false', () => {
    process.env.EMINIPLAYER_USERNAME = 'user@example.com';
    process.env.EMINIPLAYER_PASSWORD = 'secret';
    process.env.EMINIPLAYER_HEADLESS = 'false';
    process.env.EMINIPLAYER_SCREENSHOT_DIR = '/tmp/shots';
    const cfg = configuration();
    expect(cfg.eminiplayer).toEqual({
      username: 'user@example.com',
      password: 'secret',
      headless: false,
      screenshotDir: '/tmp/shots',
    });
  });

  it('treats set-but-empty values as unset (copied .env.example)', () => {
    process.env.EMINIPLAYER_USERNAME = '';
    process.env.EMINIPLAYER_PASSWORD = '';
    process.env.EMINIPLAYER_SCREENSHOT_DIR = '';
    const cfg = configuration();
    expect(cfg.eminiplayer.username).toBeUndefined();
    expect(cfg.eminiplayer.password).toBeUndefined();
    expect(cfg.eminiplayer.screenshotDir).toBe(
      resolve(__dirname, '..', '..', 'artifacts', 'eminiplayer'),
    );
  });
});
```

Also add `resolve` to the spec's imports — at the top of `configuration.spec.ts` add:

```ts
import { resolve } from 'node:path';
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && pnpm test -- configuration.spec`
Expected: FAIL — the suite fails to **compile** with TS2339 (`Property 'eminiplayer' does not exist on type 'AppConfig'`), so the whole configuration spec file — including all its pre-existing tests — reports failing until Step 4 lands. That wall of compile errors is the expected red state, not a broken existing suite; no runtime "undefined" assertion is ever reached.

- [ ] **Step 4: Implement the config namespace**

In `backend/src/config/configuration.ts` (which already has `import { resolve } from 'node:path';`), add to the `AppConfig` interface after the `benchmark` block:

```ts
  eminiplayer: {
    username?: string;
    password?: string;
    headless: boolean;
    screenshotDir: string;
  };
```

And add to the returned object after the `benchmark` entry:

```ts
  eminiplayer: {
    // `|| undefined`, not bare reads: a copied .env.example ships these keys
    // empty, and '' must read as "not configured", same convention as
    // llm.provider / moonshot.baseUrl above.
    username: process.env.EMINIPLAYER_USERNAME || undefined,
    password: process.env.EMINIPLAYER_PASSWORD || undefined,
    // Headed mode is opt-in for local debugging: EMINIPLAYER_HEADLESS=false.
    headless: process.env.EMINIPLAYER_HEADLESS !== 'false',
    // `||`, not `??` (set-but-empty must fall back too). Anchored to the
    // module location like benchmark.repoRoot above — NOT cwd, so screenshots
    // of authenticated content can never land outside backend/ (src/config
    // and dist/config are both two levels below backend/).
    screenshotDir:
      process.env.EMINIPLAYER_SCREENSHOT_DIR ||
      resolve(__dirname, '..', '..', 'artifacts', 'eminiplayer'),
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && pnpm test -- configuration.spec`
Expected: PASS (all describes in the file, including the pre-existing ones).

- [ ] **Step 6: Document env vars and ignore the artifacts dir**

Append to `backend/.env.example`:

```
# --- EminiPlayer scraper (Playwright) ---
# Credentials for eminiplayer.net. NOT committed; required only when the
# archive page needs a login.
EMINIPLAYER_USERNAME=
EMINIPLAYER_PASSWORD=
# Set to false to watch the browser locally.
EMINIPLAYER_HEADLESS=true
# Where archive-page screenshots land (default: backend/artifacts/eminiplayer)
EMINIPLAYER_SCREENSHOT_DIR=
```

Append to `backend/.gitignore`:

```
artifacts/
```

- [ ] **Step 7: Commit**

```bash
cd backend
git add package.json pnpm-lock.yaml src/config/configuration.ts src/config/configuration.spec.ts .env.example .gitignore
git commit -m "feat(eminiplayer): add playwright dependency and eminiplayer config namespace"
```

---

### Task 2: `PlaywrightService` — browser lifecycle

**Files:**
- Create: `backend/src/eminiplayer/playwright.service.ts`
- Test: `backend/src/eminiplayer/playwright.service.spec.ts`

**Interfaces:**
- Consumes: `ConfigService` key `eminiplayer.headless` (from Task 1).
- Produces: `class PlaywrightService implements OnModuleDestroy` with `withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>` — runs `fn` with exclusive access to the one shared Playwright `Page` (callbacks are serialized on an internal promise-chain mutex; the lazy Chromium launch is therefore single-flight; a dead browser process is detected via `browser.isConnected()` and relaunched; a closed page is re-created) — and `onModuleDestroy(): Promise<void>` (closes context + browser, swallowing close errors).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/eminiplayer/playwright.service.spec.ts`:

```ts
jest.mock('playwright', () => ({
  chromium: { launch: jest.fn() },
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { chromium } from 'playwright';
import { PlaywrightService } from './playwright.service';

describe('PlaywrightService', () => {
  function makeFakes() {
    const page = { isClosed: jest.fn(() => false) };
    const context = {
      newPage: jest.fn(() => Promise.resolve(page)),
      close: jest.fn(() => Promise.resolve()),
    };
    const browser = {
      isConnected: jest.fn(() => true),
      newContext: jest.fn(() => Promise.resolve(context)),
      close: jest.fn(() => Promise.resolve()),
    };
    (chromium.launch as jest.Mock).mockResolvedValue(browser);
    return { page, context, browser };
  }

  async function build(headless: boolean | undefined = true) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PlaywrightService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'eminiplayer.headless' ? headless : undefined,
            ),
          },
        },
      ],
    }).compile();
    return moduleRef.get(PlaywrightService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lazily launches chromium with the configured headless flag on first use', async () => {
    const { page } = makeFakes();
    const service = await build(false);
    expect(chromium.launch).not.toHaveBeenCalled();
    const seen = await service.withPage(async (p) => p);
    expect(seen).toBe(page);
    expect(chromium.launch).toHaveBeenCalledWith({ headless: false });
  });

  it('reuses the same page across sequential calls (single launch, single newPage)', async () => {
    const { page, context } = makeFakes();
    const service = await build();
    const first = await service.withPage(async (p) => p);
    const second = await service.withPage(async (p) => p);
    expect(first).toBe(page);
    expect(second).toBe(page);
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(context.newPage).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent callbacks and launches exactly one browser', async () => {
    makeFakes();
    const service = await build();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = service.withPage(async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = service.withPage(async () => {
      order.push('second');
    });
    // let the first callback reach its gate before releasing it
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(chromium.launch).toHaveBeenCalledTimes(1);
  });

  it('keeps serving after a callback throws', async () => {
    const { page } = makeFakes();
    const service = await build();
    await expect(
      service.withPage(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(service.withPage(async (p) => p)).resolves.toBe(page);
  });

  it('opens a fresh page when the previous one was closed', async () => {
    const { page, context } = makeFakes();
    const service = await build();
    await service.withPage(async () => undefined);
    (page.isClosed as jest.Mock).mockReturnValue(true);
    await service.withPage(async () => undefined);
    expect(context.newPage).toHaveBeenCalledTimes(2);
  });

  it('relaunches chromium when the browser process has died', async () => {
    const { browser } = makeFakes();
    const service = await build();
    await service.withPage(async () => undefined);
    (browser.isConnected as jest.Mock).mockReturnValue(false);
    await service.withPage(async () => undefined);
    expect(chromium.launch).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy closes context and browser, tolerating close errors', async () => {
    const { context, browser } = makeFakes();
    const service = await build();
    await service.withPage(async () => undefined);
    (context.close as jest.Mock).mockRejectedValue(new Error('already closed'));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it('onModuleDestroy is a no-op when nothing was launched', async () => {
    makeFakes();
    const service = await build();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test -- eminiplayer/playwright.service.spec`
Expected: FAIL — `Cannot find module './playwright.service'`.

- [ ] **Step 3: Implement `PlaywrightService`**

Create `backend/src/eminiplayer/playwright.service.ts`:

```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Owns the Chromium browser lifecycle: lazy launch on first use, one shared
 * context/page, defensive teardown on module destroy. Knows nothing about
 * eminiplayer.net. Module-private: not exported from EminiplayerModule; the
 * page it manages has a single owner (EminiplayerService).
 *
 * The page is one mutable browser tab shared by every caller, so ALL page
 * access is serialized through withPage() — exactly one callback runs at a
 * time. This also makes the lazy launch single-flight, and lets a dead
 * browser process (crash/OOM) be replaced instead of poisoning the service.
 */
@Injectable()
export class PlaywrightService implements OnModuleDestroy {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => fn(await this.acquirePage()));
    // keep the chain alive after a failure; the caller still sees the rejection
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async acquirePage(): Promise<Page> {
    if (this.browser && !this.browser.isConnected()) {
      // the Chromium process died out from under us; drop every stale ref so
      // we relaunch instead of calling newPage() on a dead context forever
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
    }
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.get<boolean>('eminiplayer.headless') ?? true,
      });
      this.context = undefined;
      this.page = undefined;
    }
    if (!this.context) {
      this.context = await this.browser.newContext();
      this.page = undefined;
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    return this.page;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // context may already be gone; teardown must not throw
    }
    try {
      await this.browser?.close();
    } catch {
      // browser may already be gone; teardown must not throw
    }
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && pnpm test -- eminiplayer/playwright.service.spec`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/eminiplayer/playwright.service.ts src/eminiplayer/playwright.service.spec.ts
git commit -m "feat(eminiplayer): add PlaywrightService managing chromium lifecycle"
```

---

### Task 3: `EminiplayerService` — login + archive navigation

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer.constants.ts`
- Create: `backend/src/eminiplayer/eminiplayer.service.ts`
- Test: `backend/src/eminiplayer/eminiplayer.service.spec.ts`

**Interfaces:**
- Consumes: `PlaywrightService.withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>` (Task 2); `ConfigService` keys `eminiplayer.username`, `eminiplayer.password`, `eminiplayer.screenshotDir` (Task 1).
- Produces: `class EminiplayerService` with `openArchivePage(): Promise<ArchivePageResult>`; `interface ArchivePageResult { url: string; title: string; screenshotPath: string }`; constants `ARCHIVE_URL`, `LOGIN_URL`, `SELECTORS` exported from `eminiplayer.constants.ts`.

- [ ] **Step 1: Create the constants file**

Create `backend/src/eminiplayer/eminiplayer.constants.ts`:

```ts
export const ARCHIVE_URL = 'https://www.eminiplayer.net/archive.aspx';
export const LOGIN_URL = 'https://www.eminiplayer.net/login.aspx';

// Selectors verified against the live site 2026-08-06 (BlogEngine.NET /
// ASP.NET WebForms markup). The nav reuses ONE anchor (#ctl00_aLogin) for
// both states: "Member Login" -> /login.aspx when logged out, "Log off" ->
// /login.aspx?logoff when logged in. So the logged-out signal is that
// anchor without the logoff query. Both halves matter: matching any
// login.aspx href would report logged-out forever (the nav's "Log off"
// link), and dropping the :not() would do the same via the members-only
// "Change password" link, which also points at /login.aspx.
export const SELECTORS = {
  loginLink: 'a#ctl00_aLogin:not([href*="logoff"])',
  username: '#ctl00_cphBody_Login1_UserName',
  password: '#ctl00_cphBody_Login1_Password',
  submit: '#ctl00_cphBody_Login1_LoginButton',
} as const;

export interface ArchivePageResult {
  url: string;
  title: string;
  screenshotPath: string;
}
```

- [ ] **Step 2: Write the failing tests**

Create `backend/src/eminiplayer/eminiplayer.service.spec.ts`:

```ts
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve(undefined)),
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { EminiplayerService } from './eminiplayer.service';
import { PlaywrightService } from './playwright.service';
import { ARCHIVE_URL, LOGIN_URL, SELECTORS } from './eminiplayer.constants';

type FakePage = {
  goto: jest.Mock;
  $: jest.Mock;
  fill: jest.Mock;
  click: jest.Mock;
  waitForURL: jest.Mock;
  url: jest.Mock;
  title: jest.Mock;
  screenshot: jest.Mock;
};

function makePage(overrides: Partial<FakePage> = {}): FakePage {
  return {
    goto: jest.fn(() => Promise.resolve(null)),
    // default: logged in (no login link found)
    $: jest.fn(() => Promise.resolve(null)),
    fill: jest.fn(() => Promise.resolve()),
    click: jest.fn(() => Promise.resolve()),
    waitForURL: jest.fn(() => Promise.resolve()),
    url: jest.fn(() => ARCHIVE_URL),
    title: jest.fn(() => Promise.resolve('Archive')),
    screenshot: jest.fn(() => Promise.resolve(Buffer.from(''))),
    ...overrides,
  };
}

async function build(
  page: FakePage,
  config: Record<string, unknown> = {
    'eminiplayer.username': 'user@example.com',
    'eminiplayer.password': 'secret',
    'eminiplayer.screenshotDir': '/tmp/eminiplayer-shots',
  },
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerService,
      {
        provide: PlaywrightService,
        // pass-through mutex: run the callback immediately with the fake page
        useValue: {
          withPage: jest.fn((fn: (p: FakePage) => Promise<unknown>) => fn(page)),
        },
      },
      {
        provide: ConfigService,
        useValue: { get: jest.fn((key: string) => config[key]) },
      },
    ],
  }).compile();
  return moduleRef.get(EminiplayerService);
}

describe('EminiplayerService.openArchivePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns metadata and screenshot path when already logged in', async () => {
    const page = makePage();
    const service = await build(page);
    const result = await service.openArchivePage();
    expect(page.goto).toHaveBeenCalledWith(ARCHIVE_URL, {
      waitUntil: 'domcontentloaded',
    });
    expect(page.fill).not.toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledWith('/tmp/eminiplayer-shots', {
      recursive: true,
    });
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true }),
    );
    expect(result.url).toBe(ARCHIVE_URL);
    expect(result.title).toBe('Archive');
    expect(result.screenshotPath).toMatch(
      /^\/tmp\/eminiplayer-shots\/archive-.+\.png$/,
    );
  });

  it('logs in when the login link is present, then lands on archive', async () => {
    // logged out on first check, logged in after the login round-trip
    const page = makePage({
      $: jest
        .fn()
        .mockResolvedValueOnce({}) // archive.aspx shows login link
        .mockResolvedValue(null), // after login: link gone
    });
    const service = await build(page);
    const result = await service.openArchivePage();
    expect(page.goto).toHaveBeenNthCalledWith(1, ARCHIVE_URL, {
      waitUntil: 'domcontentloaded',
    });
    expect(page.goto).toHaveBeenNthCalledWith(2, LOGIN_URL, {
      waitUntil: 'domcontentloaded',
    });
    expect(page.goto).toHaveBeenNthCalledWith(3, ARCHIVE_URL, {
      waitUntil: 'domcontentloaded',
    });
    expect(page.fill).toHaveBeenCalledWith(SELECTORS.username, 'user@example.com');
    expect(page.fill).toHaveBeenCalledWith(SELECTORS.password, 'secret');
    expect(page.click).toHaveBeenCalledWith(SELECTORS.submit);
    expect(page.waitForURL).toHaveBeenCalled();
    expect(result.url).toBe(ARCHIVE_URL);
  });

  it('throws a descriptive error when login does not stick', async () => {
    const page = makePage({
      $: jest.fn().mockResolvedValue({}), // login link never goes away
    });
    const service = await build(page);
    await expect(service.openArchivePage()).rejects.toThrow(
      /login failed: login link still present/,
    );
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it('throws when login is required but credentials are missing', async () => {
    const page = makePage({ $: jest.fn().mockResolvedValue({}) });
    const service = await build(page, {
      'eminiplayer.screenshotDir': '/tmp/eminiplayer-shots',
    });
    await expect(service.openArchivePage()).rejects.toThrow(
      /EMINIPLAYER_USERNAME \/ EMINIPLAYER_PASSWORD are not configured/,
    );
    expect(page.fill).not.toHaveBeenCalled();
  });

  it('throws when the final URL is not the archive page', async () => {
    const page = makePage({
      url: jest.fn(() => 'https://www.eminiplayer.net/default.aspx'),
    });
    const service = await build(page);
    await expect(service.openArchivePage()).rejects.toThrow(
      /expected archive\.aspx/,
    );
  });

  it('rejects the forms-auth redirect URL that contains archive.aspx as a substring', async () => {
    const page = makePage({
      url: jest.fn(
        () => 'https://www.eminiplayer.net/login.aspx?ReturnUrl=%2farchive.aspx',
      ),
    });
    const service = await build(page);
    await expect(service.openArchivePage()).rejects.toThrow(
      /expected archive\.aspx/,
    );
  });

  it('prefixes navigation failures with step context', async () => {
    const page = makePage({
      goto: jest.fn(() => Promise.reject(new Error('Timeout 30000ms exceeded'))),
    });
    const service = await build(page);
    await expect(service.openArchivePage()).rejects.toThrow(
      /eminiplayer: navigating to archive\.aspx failed: Timeout 30000ms exceeded/,
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && pnpm test -- eminiplayer/eminiplayer.service.spec`
Expected: FAIL — `Cannot find module './eminiplayer.service'`.

- [ ] **Step 4: Implement `EminiplayerService`**

Create `backend/src/eminiplayer/eminiplayer.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { PlaywrightService } from './playwright.service';
import {
  ARCHIVE_URL,
  LOGIN_URL,
  SELECTORS,
  ArchivePageResult,
} from './eminiplayer.constants';

/**
 * Site-specific navigation for eminiplayer.net. openArchivePage() lands an
 * authenticated browser page on archive.aspx and returns proof; the page
 * stays open (via PlaywrightService) for future parsing calls. The whole
 * flow runs inside one withPage() callback, so concurrent callers cannot
 * interleave navigations. Future parsing methods must do the same, and
 * re-assert the page URL rather than assume where the page was left.
 */
@Injectable()
export class EminiplayerService {
  private readonly logger = new Logger(EminiplayerService.name);

  constructor(
    private readonly playwright: PlaywrightService,
    private readonly config: ConfigService,
  ) {}

  async openArchivePage(): Promise<ArchivePageResult> {
    return this.playwright.withPage(async (page) => {
      await this.goto(page, ARCHIVE_URL, 'navigating to archive.aspx');

      if (await this.isLoggedOut(page)) {
        this.logger.log('Not authenticated; logging in');
        await this.login(page);
        await this.goto(page, ARCHIVE_URL, 're-navigating to archive.aspx after login');
        if (await this.isLoggedOut(page)) {
          throw new Error(
            'eminiplayer login failed: login link still present after signing in (check credentials)',
          );
        }
      }

      this.assertOnArchivePage(page);
      const screenshotPath = await this.screenshot(page);
      return { url: page.url(), title: await page.title(), screenshotPath };
    });
  }

  /**
   * Logged-out signal — see the SELECTORS.loginLink comment block in
   * eminiplayer.constants.ts for why the :not([href*="logoff"]) half is
   * load-bearing.
   */
  private async isLoggedOut(page: Page): Promise<boolean> {
    return (await page.$(SELECTORS.loginLink)) !== null;
  }

  /**
   * Structural URL check — a substring test would pass on
   * login.aspx?ReturnUrl=%2farchive.aspx, the URL a failed forms-auth
   * flow produces.
   */
  private assertOnArchivePage(page: Page): void {
    const url = new URL(page.url());
    const onArchive =
      (url.hostname === 'eminiplayer.net' ||
        url.hostname.endsWith('.eminiplayer.net')) &&
      url.pathname.toLowerCase() === '/archive.aspx';
    if (!onArchive) {
      throw new Error(
        `eminiplayer navigation failed: expected archive.aspx, landed on ${page.url()}`,
      );
    }
  }

  private async goto(page: Page, url: string, step: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      throw new Error(`eminiplayer: ${step} failed: ${(err as Error).message}`);
    }
  }

  private async login(page: Page): Promise<void> {
    const username = this.config.get<string>('eminiplayer.username');
    const password = this.config.get<string>('eminiplayer.password');
    if (!username || !password) {
      throw new Error(
        'eminiplayer login required but EMINIPLAYER_USERNAME / EMINIPLAYER_PASSWORD are not configured',
      );
    }
    await this.goto(page, LOGIN_URL, 'navigating to login.aspx');
    await page.fill(SELECTORS.username, username);
    await page.fill(SELECTORS.password, password);
    try {
      // ASP.NET WebForms submit triggers a full postback; on success the site
      // redirects away from login.aspx. On bad credentials the URL never
      // changes, so this times out (30s) — the step prefix keeps that
      // diagnosable. (waitForURL, not the deprecated racy waitForNavigation.)
      await Promise.all([
        page.waitForURL(
          (u) => !u.pathname.toLowerCase().includes('login.aspx'),
          { waitUntil: 'domcontentloaded' },
        ),
        page.click(SELECTORS.submit),
      ]);
    } catch (err) {
      throw new Error(
        `eminiplayer: submitting login failed: ${(err as Error).message}`,
      );
    }
  }

  private async screenshot(page: Page): Promise<string> {
    const dir = this.config.get<string>('eminiplayer.screenshotDir') as string;
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `archive-${stamp}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && pnpm test -- eminiplayer/eminiplayer.service.spec`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
cd backend
git add src/eminiplayer/eminiplayer.constants.ts src/eminiplayer/eminiplayer.service.ts src/eminiplayer/eminiplayer.service.spec.ts
git commit -m "feat(eminiplayer): add EminiplayerService with login-aware archive navigation"
```

---

### Task 4: `EminiplayerModule`, AppModule wiring, docs, full verification

**Files:**
- Create: `backend/src/eminiplayer/eminiplayer.module.ts`
- Test: `backend/src/eminiplayer/eminiplayer.module.spec.ts`
- Modify: `backend/src/app.module.ts` (imports array)
- Modify: `backend/README.md`

**Interfaces:**
- Consumes: `PlaywrightService` (Task 2), `EminiplayerService` (Task 3), global `ConfigModule` (already in AppModule).
- Produces: `EminiplayerModule` exporting `EminiplayerService` (only — `PlaywrightService` stays module-private) for future consumer modules.

- [ ] **Step 1: Write the failing module test**

Create `backend/src/eminiplayer/eminiplayer.module.spec.ts` (`ignoreEnvFile: true` keeps ambient `.env` — which may hold real credentials after Step 7 — out of unit tests, matching the anthropic/moonshot module specs):

```ts
jest.mock('playwright', () => ({
  chromium: { launch: jest.fn() },
}));

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { EminiplayerModule } from './eminiplayer.module';
import { EminiplayerService } from './eminiplayer.service';
import { chromium } from 'playwright';

describe('EminiplayerModule', () => {
  it('compiles and resolves EminiplayerService without launching a browser', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [configuration],
        }),
        EminiplayerModule,
      ],
    }).compile();
    expect(moduleRef.get(EminiplayerService)).toBeInstanceOf(EminiplayerService);
    expect(chromium.launch).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test -- eminiplayer/eminiplayer.module.spec`
Expected: FAIL — `Cannot find module './eminiplayer.module'`.

- [ ] **Step 3: Implement the module and register it in AppModule**

Create `backend/src/eminiplayer/eminiplayer.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PlaywrightService } from './playwright.service';
import { EminiplayerService } from './eminiplayer.service';

@Module({
  providers: [PlaywrightService, EminiplayerService],
  // PlaywrightService is deliberately NOT exported: the shared page has a
  // single owner and all access must go through EminiplayerService.
  exports: [EminiplayerService],
})
export class EminiplayerModule {}
```

In `backend/src/app.module.ts`, add the import statement alongside the other module imports:

```ts
import { EminiplayerModule } from './eminiplayer/eminiplayer.module';
```

and add `EminiplayerModule,` to the `imports` array after `CostModule`. (This registration is approved scope per the spec — it lets the manual smoke test resolve the service from the app context.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test -- eminiplayer/eminiplayer.module.spec`
Expected: PASS.

- [ ] **Step 5: Run the full backend suites and build**

Run: `cd backend && pnpm test && pnpm test:e2e && pnpm build`
Expected: all PASS with no type errors. `pnpm test:e2e` matters here: the e2e suites in `backend/test/` boot the real `AppModule` — which now pulls in `EminiplayerModule` — and they only run under this separate command (`pnpm test` cannot reach them: its jest config is rooted at `src/`).

- [ ] **Step 6: Document the module in the README**

Append to `backend/README.md`:

```markdown
## EminiPlayer scraper (Playwright)

`src/eminiplayer/` provides `EminiplayerService.openArchivePage()`, which
drives a Playwright Chromium browser to https://www.eminiplayer.net/archive.aspx,
logging in first when the site shows its login link. It returns
`{ url, title, screenshotPath }` and saves a full-page screenshot under
`artifacts/eminiplayer/` (git-ignored). No content parsing yet.

Setup:

1. `pnpm exec playwright install chromium` (one-time browser download)
2. Set `EMINIPLAYER_USERNAME` / `EMINIPLAYER_PASSWORD` in `.env`
   (see `.env.example`; `EMINIPLAYER_HEADLESS=false` shows the browser)

Manual smoke test — hits the live site. Prerequisites: credentials in `.env`
and working GCP ADC (booting the app context initializes the Firebase
module). `BENCHMARK_SCHEDULER=false` keeps the benchmark reconciler/crons
from touching Firestore as a side effect:

    BENCHMARK_SCHEDULER=false pnpm exec ts-node -e "const { NestFactory } = require('@nestjs/core'); \
    const { AppModule } = require('./src/app.module'); \
    const { EminiplayerService } = require('./src/eminiplayer/eminiplayer.service'); \
    (async () => { \
      const app = await NestFactory.createApplicationContext(AppModule); \
      console.log(await app.get(EminiplayerService).openArchivePage()); \
      await app.close(); \
    })();"
```

- [ ] **Step 7: Manual live verification (needs credentials in `backend/.env` + GCP ADC)**

Put the eminiplayer credentials in `backend/.env` (`EMINIPLAYER_USERNAME=...`, `EMINIPLAYER_PASSWORD=...`), then run the README smoke-test command from `backend/` (including the `BENCHMARK_SCHEDULER=false` prefix).
Expected: console prints `{ url: 'https://www.eminiplayer.net/archive.aspx', title: <page title>, screenshotPath: '<absolute path>/backend/artifacts/eminiplayer/archive-<stamp>.png' }` — note the screenshotPath is **absolute** (the config anchors it to `backend/`) — and the screenshot file shows the archive page without a "log in" link. A wrong password surfaces as `eminiplayer: submitting login failed: Timeout 30000ms...` after ~30s. If the login selectors have drifted from the site facts in Global Constraints, fix `eminiplayer.constants.ts` and re-run. (Skip this step if credentials are unavailable; note that in the task report.)

- [ ] **Step 8: Commit**

```bash
cd backend
git add src/eminiplayer/eminiplayer.module.ts src/eminiplayer/eminiplayer.module.spec.ts src/app.module.ts README.md
git commit -m "feat(eminiplayer): register EminiplayerModule and document the scraper"
```
