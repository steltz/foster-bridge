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
