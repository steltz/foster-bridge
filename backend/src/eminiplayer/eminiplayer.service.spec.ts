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
  // pass-through mutex: run the callback immediately with the fake page
  const playwright = {
    withPage: jest.fn((fn: (p: FakePage) => Promise<unknown>) => fn(page)),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerService,
      { provide: PlaywrightService, useValue: playwright },
      {
        provide: ConfigService,
        useValue: { get: jest.fn((key: string) => config[key]) },
      },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerService), playwright };
}

describe('EminiplayerService.openArchivePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns metadata and screenshot path when already logged in', async () => {
    const page = makePage();
    const { service } = await build(page);
    const result = await service.openArchivePage();
    expect(page.goto).toHaveBeenCalledWith(ARCHIVE_URL, {
      waitUntil: 'domcontentloaded',
    });
    expect(page.$).toHaveBeenCalledWith(SELECTORS.loginLink);
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
    const { service } = await build(page);
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
    const { service } = await build(page);
    await expect(service.openArchivePage()).rejects.toThrow(
      /login failed: login link still present/,
    );
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it('throws when login is required but credentials are missing', async () => {
    const page = makePage({ $: jest.fn().mockResolvedValue({}) });
    const { service } = await build(page, {
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
    const { service } = await build(page);
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
    const { service } = await build(page);
    await expect(service.openArchivePage()).rejects.toThrow(
      /expected archive\.aspx/,
    );
  });

  it('prefixes navigation failures with step context', async () => {
    const page = makePage({
      goto: jest.fn(() => Promise.reject(new Error('Timeout 30000ms exceeded'))),
    });
    const { service } = await build(page);
    await expect(service.openArchivePage()).rejects.toThrow(
      /eminiplayer: navigating to archive\.aspx failed: Timeout 30000ms exceeded/,
    );
  });
});

describe('scraper contract stubs', () => {
  it('findDayEntries navigates to the archive authenticated, then throws not-implemented', async () => {
    const page = makePage(); // default: logged in, url() === ARCHIVE_URL
    const { service } = await build(page);
    await expect(service.findDayEntries('07012026')).rejects.toThrow(
      'eminiplayer: findDayEntries selectors not implemented yet',
    );
    expect(page.goto).toHaveBeenCalledWith(ARCHIVE_URL, expect.anything());
  });

  it('findDayEntries logs in first when logged out', async () => {
    const page = makePage({
      // 1st check (archive): logged out; 2nd check (after login): logged in
      $: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValue(null),
    });
    const { service } = await build(page);
    await expect(service.findDayEntries('07012026')).rejects.toThrow(
      'selectors not implemented',
    );
    expect(page.fill).toHaveBeenCalledWith(SELECTORS.username, 'user@example.com');
    expect(page.click).toHaveBeenCalledWith(SELECTORS.submit);
  });

  it('getYoutubeUrl navigates to the detail page authenticated, then throws not-implemented', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/some-entry.aspx';
    const page = makePage({ url: jest.fn(() => detailUrl) });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(
      'eminiplayer: getYoutubeUrl selectors not implemented yet',
    );
    expect(page.goto).toHaveBeenCalledWith(detailUrl, expect.anything());
  });

  it('getYoutubeUrl throws a navigation error when the site redirects off the detail page', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/some-entry.aspx';
    // landed somewhere else (soft-404 / upsell / home) that is NOT logged-out
    const page = makePage({ url: jest.fn(() => 'https://www.eminiplayer.net/default.aspx') });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(
      'eminiplayer navigation failed',
    );
  });

  it('getYoutubeUrl accepts www <-> apex host canonicalization (same path)', async () => {
    // requested www, landed on apex — the host variance assertOnArchivePage
    // already tolerates; must reach the extraction point, not a nav error
    const detailUrl = 'https://www.eminiplayer.net/post/some-entry.aspx';
    const page = makePage({ url: jest.fn(() => 'https://eminiplayer.net/post/some-entry.aspx') });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(
      'eminiplayer: getYoutubeUrl selectors not implemented yet',
    );
  });

  it('downloadTradePlanPdf navigates to the detail page authenticated, then throws not-implemented', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/tp-entry.aspx';
    const page = makePage({ url: jest.fn(() => detailUrl) });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toThrow(
      'eminiplayer: downloadTradePlanPdf selectors not implemented yet',
    );
    expect(page.goto).toHaveBeenCalledWith(detailUrl, expect.anything());
  });

  it('downloadTradePlanPdf throws a navigation error when the site redirects off the detail page', async () => {
    const detailUrl = 'https://www.eminiplayer.net/post/tp-entry.aspx';
    const page = makePage({ url: jest.fn(() => 'https://www.eminiplayer.net/default.aspx') });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toThrow(
      'eminiplayer navigation failed',
    );
  });

  it('each scraper method runs inside withPage (serialized page access)', async () => {
    const page = makePage();
    const { service, playwright } = await build(page);
    await service.findDayEntries('07012026').catch(() => undefined);
    await service.getYoutubeUrl('https://www.eminiplayer.net/x').catch(() => undefined);
    await service.downloadTradePlanPdf('https://www.eminiplayer.net/x').catch(() => undefined);
    expect((playwright.withPage as jest.Mock).mock.calls.length).toBe(3);
  });
});
