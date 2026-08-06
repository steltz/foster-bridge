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
        await this.goto(
          page,
          ARCHIVE_URL,
          're-navigating to archive.aspx after login',
        );
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
   * eminiplayer.constants.ts for why the `:not([href*="logoff"])` half is
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
        page.waitForURL((u) => !u.pathname.toLowerCase().includes('login.aspx'), {
          waitUntil: 'domcontentloaded',
        }),
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
