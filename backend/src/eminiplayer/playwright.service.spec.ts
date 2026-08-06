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
