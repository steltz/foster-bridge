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
import { resolveEntryUrl, selectDayEntries, RawArchiveRow } from './eminiplayer-archive';
import { extractYoutubeVideoId } from './eminiplayer-validation';

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
   * One authenticated scrape of the archive listing's raw rows. Extracted from
   * findDayEntries so the bulk backfill can scrape ONCE and derive every day's
   * entries from the same capture (the listing is 1.7 MB — re-downloading it
   * per day tripled the site footprint).
   */
  async fetchArchiveRows(): Promise<RawArchiveRow[]> {
    return this.playwright.withPage(async (page) => {
      await this.gotoAuthenticated(
        page,
        ARCHIVE_URL,
        'navigating to archive.aspx',
      );
      this.assertOnArchivePage(page);
      return page.$$eval(SELECTORS.archiveRows, (trs) =>
        trs.map((tr) => {
          const anchor = tr.querySelector('td.title a');
          return {
            dateText: tr.querySelector('td.date')?.textContent?.trim() ?? '',
            href: anchor?.getAttribute('href') ?? '',
            title: anchor?.textContent?.trim() ?? '',
          };
        }),
      );
    });
  }

  /**
   * Scan the archive listing for the trade-plan entry dated `date` (MMDDYYYY)
   * and the most recent recap entry dated strictly before it. Row selection,
   * three-way date agreement, and the RECAP_LOOKBACK_DAYS bound live in
   * eminiplayer-archive.ts (selectDayEntries). Throws ArchiveNotFoundError
   * when the day (or its recap) is not in the archive — the controller maps
   * that to 404.
   */
  async findDayEntries(date: string): Promise<DayEntries> {
    const rows = await this.fetchArchiveRows();
    return selectDayEntries(rows, date, ARCHIVE_URL);
  }

  /**
   * Extract the embedded YouTube URL from an archive detail page. Both TP and
   * recap pages embed their video as a youtube.com/embed/<id> iframe, next to
   * a Twitter-widget iframe that must be ignored — so a src only counts when
   * extractYoutubeVideoId accepts it (host allowlist + id shape).
   */
  async getYoutubeUrl(pageUrl: string): Promise<string> {
    return this.playwright.withPage(async (page) => {
      await this.gotoAuthenticated(page, pageUrl, `navigating to ${pageUrl}`);
      this.assertOnPage(page, pageUrl);
      const srcs = await page.$$eval('iframe', (els) =>
        els.map((el) => el.getAttribute('src') ?? ''),
      );
      for (const src of srcs) {
        try {
          extractYoutubeVideoId(src);
          return src;
        } catch {
          // not a YouTube embed (Twitter widget, ad frame, empty src)
        }
      }
      throw new Error(`eminiplayer: no YouTube embed found on ${pageUrl}`);
    });
  }

  /**
   * Download the trade-plan PDF (the "Trader Worksheet") linked from a TP
   * detail page. The site serves it via /file.axd?file=...pdf, so the PDF-ness
   * lives in the `file` query param, not the pathname; the page also links a
   * zones .zip through the same handler, which must not match. The fetch goes
   * through page.request (shares the page's authenticated cookies) — no
   * Playwright download event needed; verified against the live site
   * 2026-08-14.
   */
  async downloadTradePlanPdf(pageUrl: string): Promise<Buffer> {
    return this.playwright.withPage(async (page) => {
      await this.gotoAuthenticated(page, pageUrl, `navigating to ${pageUrl}`);
      this.assertOnPage(page, pageUrl);
      const hrefs = await page.$$eval('a', (els) =>
        els.map((el) => el.getAttribute('href') ?? ''),
      );
      const pdfUrl = this.findPdfUrl(hrefs, pageUrl);
      if (!pdfUrl) {
        throw new Error(`eminiplayer: no trade-plan PDF link found on ${pageUrl}`);
      }
      const response = await page.request.get(pdfUrl);
      if (!response.ok()) {
        throw new Error(
          `eminiplayer: downloading ${pdfUrl} failed with HTTP ${response.status()}`,
        );
      }
      return Buffer.from(await response.body());
    });
  }

  /**
   * First href that resolves to a .pdf (by pathname or file.axd `file` query
   * param), same-origin enforced via resolveEntryUrl BEFORE the URL reaches a
   * credentialed fetch.
   */
  private findPdfUrl(hrefs: string[], pageUrl: string): string | null {
    for (const href of hrefs) {
      if (!href) continue;
      let url: URL;
      try {
        url = new URL(href, pageUrl);
      } catch {
        continue;
      }
      const fileParam = url.searchParams.get('file') ?? '';
      if (!/\.pdf$/i.test(url.pathname) && !/\.pdf$/i.test(fileParam)) continue;
      return resolveEntryUrl(href, pageUrl);
    }
    return null;
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
