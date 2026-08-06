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
  DayEntries,
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
      await this.gotoAuthenticated(
        page,
        ARCHIVE_URL,
        'navigating to archive.aspx',
      );
      this.assertOnArchivePage(page);
      const screenshotPath = await this.screenshot(page);
      return { url: page.url(), title: await page.title(), screenshotPath };
    });
  }

  /**
   * Scan the archive listing for the trade-plan entry dated `date` (MMDDYYYY)
   * and the most recent recap entry dated strictly before it.
   */
  async findDayEntries(date: string): Promise<DayEntries> {
    return this.playwright.withPage(async (page) => {
      await this.gotoAuthenticated(
        page,
        ARCHIVE_URL,
        'navigating to archive.aspx',
      );
      this.assertOnArchivePage(page);
      // TODO(selectors): parse the listing rows into ArchiveEntry[] and select
      // the TP entry for `date` + the latest recap before it. Contract for the
      // selector follow-up:
      //  - THREE-WAY DATE AGREEMENT: only return an entry when the row's date,
      //    the date printed in the entry title ("...for Tuesday 04/10/2018"),
      //    and the title's printed weekday (vs what that calendar date actually
      //    falls on) all agree — an off-by-one-row parse must fail loudly, not
      //    file a document under the wrong day.
      //  - throw ArchiveNotFoundError (eminiplayer.constants) when there is no
      //    TP entry for `date`, or no recap entry dated within
      //    RECAP_LOOKBACK_DAYS calendar days strictly before it — the
      //    controller maps that to 404, and the bound keeps the scan from
      //    walking the whole multi-year archive inside this withPage callback.
      throw new Error('eminiplayer: findDayEntries selectors not implemented yet');
    });
  }

  /** Extract the embedded YouTube URL from an archive detail page. */
  async getYoutubeUrl(pageUrl: string): Promise<string> {
    return this.playwright.withPage(async (page) => {
      await this.gotoAuthenticated(page, pageUrl, `navigating to ${pageUrl}`);
      this.assertOnPage(page, pageUrl);
      // TODO(selectors): locate the embedded YouTube iframe/link on the page.
      throw new Error('eminiplayer: getYoutubeUrl selectors not implemented yet');
    });
  }

  /** Download the trade-plan PDF linked from a TP detail page. */
  async downloadTradePlanPdf(pageUrl: string): Promise<Buffer> {
    return this.playwright.withPage(async (page) => {
      await this.gotoAuthenticated(page, pageUrl, `navigating to ${pageUrl}`);
      this.assertOnPage(page, pageUrl);
      // TODO(selectors): find the PDF link and capture the download as a Buffer.
      throw new Error(
        'eminiplayer: downloadTradePlanPdf selectors not implemented yet',
      );
    });
  }

  /**
   * Navigate to `url`, logging in (and re-navigating) when the site shows its
   * logged-out state. Shared by every public method; must be called inside a
   * withPage() callback.
   */
  private async gotoAuthenticated(
    page: Page,
    url: string,
    step: string,
  ): Promise<void> {
    await this.goto(page, url, step);
    if (await this.isLoggedOut(page)) {
      this.logger.log('Not authenticated; logging in');
      await this.login(page);
      await this.goto(page, url, `re-${step} after login`);
      if (await this.isLoggedOut(page)) {
        throw new Error(
          'eminiplayer login failed: login link still present after signing in (check credentials)',
        );
      }
    }
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

  /**
   * Structural check that the page landed where we asked. Same rationale as
   * assertOnArchivePage: a redirect (login.aspx?ReturnUrl=..., soft-404, home
   * page) must fail loudly here, not surface later as a selector mismatch.
   * Hostname comparison tolerates www. <-> apex canonicalization — the same
   * host variance assertOnArchivePage deliberately accepts — while keeping the
   * pathname check exact.
   */
  private assertOnPage(page: Page, expectedUrl: string): void {
    const url = new URL(page.url());
    const expected = new URL(expectedUrl);
    const normalizeHost = (h: string) => h.replace(/^www\./, '');
    const landed =
      normalizeHost(url.hostname) === normalizeHost(expected.hostname) &&
      url.pathname.toLowerCase() === expected.pathname.toLowerCase();
    if (!landed) {
      throw new Error(
        `eminiplayer navigation failed: expected ${expectedUrl}, landed on ${page.url()}`,
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
