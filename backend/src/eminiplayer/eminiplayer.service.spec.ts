jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve(undefined)),
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { EminiplayerService } from './eminiplayer.service';
import { PlaywrightService } from './playwright.service';
import {
  ARCHIVE_URL,
  ArchiveNotFoundError,
  LOGIN_URL,
  SELECTORS,
} from './eminiplayer.constants';
import { IngestValidationError } from './eminiplayer-ingest.errors';

type FakePage = {
  goto: jest.Mock;
  $: jest.Mock;
  $$eval: jest.Mock;
  fill: jest.Mock;
  click: jest.Mock;
  waitForURL: jest.Mock;
  url: jest.Mock;
  title: jest.Mock;
  screenshot: jest.Mock;
  request: { get: jest.Mock };
};

function makePage(overrides: Partial<FakePage> = {}): FakePage {
  return {
    goto: jest.fn(() => Promise.resolve(null)),
    // default: logged in (no login link found)
    $: jest.fn(() => Promise.resolve(null)),
    $$eval: jest.fn(() => Promise.resolve([])),
    fill: jest.fn(() => Promise.resolve()),
    click: jest.fn(() => Promise.resolve()),
    waitForURL: jest.fn(() => Promise.resolve()),
    url: jest.fn(() => ARCHIVE_URL),
    title: jest.fn(() => Promise.resolve('Archive')),
    screenshot: jest.fn(() => Promise.resolve(Buffer.from(''))),
    request: { get: jest.fn() },
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

describe('findDayEntries', () => {
  // Row fixtures mirror the captured "Members Only" listing table.
  const LISTING_ROWS = [
    { dateText: '2026-08-13', href: '/post/2026/08/13/ES-Recap-(Video-Lesson)-for-Thursday-08132026.aspx', title: 'ES Recap (Video Lesson) for Thursday 08/13/2026' },
    { dateText: '2026-08-13', href: '/post/2026/08/13/ES-Key-Zones-and-Trade-Plan-for-Thursday-08132026.aspx', title: 'ES Key Zones and Trade Plan for Thursday 08/13/2026' },
    { dateText: '2026-08-12', href: '/post/2026/08/12/ES-Recap-(Video-Lesson)-for-Wed-08122026.aspx', title: 'ES Recap (Video Lesson) for Wed. 08/12/2026' },
    { dateText: '2026-08-12', href: '/post/2026/08/12/ES-Key-Zones-and-Trade-Plan-for-Wed-08122026.aspx', title: 'ES Key Zones and Trade Plan for Wed. 08/12/2026' },
  ];

  beforeEach(() => jest.clearAllMocks());

  it('scrapes the listing rows and returns the TP for the date plus the prior recap', async () => {
    const page = makePage({ $$eval: jest.fn(() => Promise.resolve(LISTING_ROWS)) });
    const { service } = await build(page);
    const entries = await service.findDayEntries('08132026');
    expect(page.goto).toHaveBeenCalledWith(ARCHIVE_URL, expect.anything());
    expect(page.$$eval).toHaveBeenCalledWith(SELECTORS.archiveRows, expect.any(Function));
    expect(entries.tradePlan).toEqual({
      date: '08132026',
      pageUrl: 'https://www.eminiplayer.net/post/2026/08/13/ES-Key-Zones-and-Trade-Plan-for-Thursday-08132026.aspx',
      title: 'ES Key Zones and Trade Plan for Thursday 08/13/2026',
    });
    expect(entries.recap.date).toBe('08122026');
  });

  it('throws ArchiveNotFoundError when the listing has no TP entry for the date', async () => {
    const page = makePage({ $$eval: jest.fn(() => Promise.resolve(LISTING_ROWS)) });
    const { service } = await build(page);
    await expect(service.findDayEntries('08142026')).rejects.toBeInstanceOf(ArchiveNotFoundError);
  });

  it('logs in first when logged out, then scrapes', async () => {
    const page = makePage({
      // 1st check (archive): logged out; 2nd check (after login): logged in
      $: jest.fn().mockResolvedValueOnce({}).mockResolvedValue(null),
      $$eval: jest.fn(() => Promise.resolve(LISTING_ROWS)),
    });
    const { service } = await build(page);
    const entries = await service.findDayEntries('08132026');
    expect(page.fill).toHaveBeenCalledWith(SELECTORS.username, 'user@example.com');
    expect(page.click).toHaveBeenCalledWith(SELECTORS.submit);
    expect(entries.tradePlan.date).toBe('08132026');
  });

  it('fetchArchiveRows scrapes the authenticated listing once and returns raw rows', async () => {
    const page = makePage({ $$eval: jest.fn(() => Promise.resolve(LISTING_ROWS)) });
    const { service } = await build(page);
    const rows = await service.fetchArchiveRows();
    expect(page.goto).toHaveBeenCalledWith(ARCHIVE_URL, expect.anything());
    expect(page.$$eval).toHaveBeenCalledWith(SELECTORS.archiveRows, expect.any(Function));
    expect(rows).toEqual(LISTING_ROWS);
  });
});

describe('getYoutubeUrl', () => {
  const detailUrl = 'https://www.eminiplayer.net/post/2026/08/13/ES-Recap-(Video-Lesson)-for-Thursday-08132026.aspx';
  // iframe srcs verbatim from the captured recap detail page: the YouTube
  // player plus the Twitter widget that must be ignored.
  const IFRAME_SRCS = [
    'https://www.youtube.com/embed/SHWb4rz_lMI?vq=hd720&rel=0&showinfo=0&modestbranding=1&&playsinline=1&enablejsapi=1&origin=https://www.eminiplayer.net',
    'https://platform.twitter.com/widgets/widget_iframe.1227a5674072e080ffb1ba14ac0c1079.html?origin=https%3A%2F%2Fwww.eminiplayer.net',
  ];

  beforeEach(() => jest.clearAllMocks());

  it('returns the YouTube embed src, ignoring non-YouTube iframes', async () => {
    const page = makePage({
      url: jest.fn(() => detailUrl),
      $$eval: jest.fn(() => Promise.resolve(IFRAME_SRCS)),
    });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).resolves.toBe(IFRAME_SRCS[0]);
    expect(page.goto).toHaveBeenCalledWith(detailUrl, expect.anything());
  });

  it('ignores a leading non-YouTube iframe (order independence)', async () => {
    const page = makePage({
      url: jest.fn(() => detailUrl),
      $$eval: jest.fn(() => Promise.resolve([IFRAME_SRCS[1], IFRAME_SRCS[0]])),
    });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).resolves.toBe(IFRAME_SRCS[0]);
  });

  it('throws a descriptive error when the page has no YouTube embed', async () => {
    const page = makePage({
      url: jest.fn(() => detailUrl),
      $$eval: jest.fn(() => Promise.resolve([IFRAME_SRCS[1]])),
    });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(/no YouTube embed/);
  });

  it('throws a navigation error when the site redirects off the detail page', async () => {
    // landed somewhere else (soft-404 / upsell / home) that is NOT logged-out
    const page = makePage({ url: jest.fn(() => 'https://www.eminiplayer.net/default.aspx') });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).rejects.toThrow(
      'eminiplayer navigation failed',
    );
  });

  it('accepts www <-> apex host canonicalization (same path)', async () => {
    // requested www, landed on apex — the host variance assertOnArchivePage
    // already tolerates; must reach the extraction point, not a nav error
    const apexUrl = detailUrl.replace('www.', '');
    const page = makePage({
      url: jest.fn(() => apexUrl),
      $$eval: jest.fn(() => Promise.resolve(IFRAME_SRCS)),
    });
    const { service } = await build(page);
    await expect(service.getYoutubeUrl(detailUrl)).resolves.toBe(IFRAME_SRCS[0]);
  });
});

describe('downloadTradePlanPdf', () => {
  const detailUrl = 'https://www.eminiplayer.net/post/2026/08/13/ES-Key-Zones-and-Trade-Plan-for-Thursday-08132026.aspx';
  // hrefs verbatim from the captured TP detail page: the worksheet PDF is
  // linked three times via /file.axd, next to a zones .zip that must be
  // ignored.
  const PAGE_HREFS = [
    '/post/2012/10/30/EMiniPlayer-Zones-Indicator.aspx',
    '/file.axd?file=2026%2f8%2f20260813TW-A77.pdf',
    '/file.axd?file=2026%2f8%2f20260813TW-A77.pdf',
    '/file.axd?file=2026%2f8%2fES_ZONES_1260813_A77.zip',
  ];
  const PDF_BYTES = Buffer.from('%PDF-1.7 fake body');

  const okResponse = () => ({
    ok: () => true,
    status: () => 200,
    body: () => Promise.resolve(PDF_BYTES),
  });

  beforeEach(() => jest.clearAllMocks());

  it('finds the file.axd PDF link, fetches it through the page session, and returns the bytes', async () => {
    const page = makePage({
      url: jest.fn(() => detailUrl),
      $$eval: jest.fn(() => Promise.resolve(PAGE_HREFS)),
      request: { get: jest.fn(() => Promise.resolve(okResponse())) },
    });
    const { service } = await build(page);
    const buf = await service.downloadTradePlanPdf(detailUrl);
    expect(buf.equals(PDF_BYTES)).toBe(true);
    expect(page.request.get).toHaveBeenCalledWith(
      'https://www.eminiplayer.net/file.axd?file=2026%2f8%2f20260813TW-A77.pdf',
    );
    expect(page.request.get).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error when the page has no PDF link', async () => {
    const page = makePage({
      url: jest.fn(() => detailUrl),
      $$eval: jest.fn(() => Promise.resolve([PAGE_HREFS[0], PAGE_HREFS[3]])),
    });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toThrow(/no trade-plan PDF link/);
  });

  it('rejects a foreign-origin PDF link instead of fetching it with credentials', async () => {
    const page = makePage({
      url: jest.fn(() => detailUrl),
      $$eval: jest.fn(() => Promise.resolve(['https://evil.example.com/plan.pdf'])),
    });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toBeInstanceOf(IngestValidationError);
    expect(page.request.get).not.toHaveBeenCalled();
  });

  it('throws with the HTTP status when the download fails', async () => {
    const page = makePage({
      url: jest.fn(() => detailUrl),
      $$eval: jest.fn(() => Promise.resolve(PAGE_HREFS)),
      request: {
        get: jest.fn(() =>
          Promise.resolve({ ok: () => false, status: () => 403, body: () => Promise.resolve(Buffer.alloc(0)) }),
        ),
      },
    });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toThrow(/HTTP 403/);
  });

  it('throws a navigation error when the site redirects off the detail page', async () => {
    const page = makePage({ url: jest.fn(() => 'https://www.eminiplayer.net/default.aspx') });
    const { service } = await build(page);
    await expect(service.downloadTradePlanPdf(detailUrl)).rejects.toThrow(
      'eminiplayer navigation failed',
    );
  });
});

describe('scraper serialization', () => {
  it('each scraper method runs inside withPage (serialized page access)', async () => {
    const page = makePage();
    const { service, playwright } = await build(page);
    await service.findDayEntries('07012026').catch(() => undefined);
    await service.getYoutubeUrl('https://www.eminiplayer.net/x').catch(() => undefined);
    await service.downloadTradePlanPdf('https://www.eminiplayer.net/x').catch(() => undefined);
    expect((playwright.withPage as jest.Mock).mock.calls.length).toBe(3);
  });
});
