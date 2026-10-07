import { describe, expect, it } from 'vitest';
import { isBlockedPage, parseConfig } from '../src/watch/pricewatch.js';
import { PublicPriceBrowser, usesPublicBrowser } from '../src/watch/pricewatch-browser.js';
import { pricewatchNotifier } from '../src/watch/pricewatch-notify.js';

const log = { info: () => undefined, warn: () => undefined };
describe('public browser and bot identity', () => {
  it('only allowlisted public HTTPS stores, not lookalike/subdomain/private hosts', () => {
    expect(usesPublicBrowser('https://www.amazon.es/s?k=tv')).toBe(true);
    expect(usesPublicBrowser('https://www.mediamarkt.es/es/category/tv.html')).toBe(true);
    expect(usesPublicBrowser('https://www.pccomponentes.com/televisores')).toBe(true);
    for (const u of [
      'http://www.amazon.es',
      'https://amazon.es.evil.test',
      'https://localhost',
      'https://internal.amazon.es',
      'https://www.fnac.es',
    ])
      expect(usesPublicBrowser(u)).toBe(false);
  });
  it('Akamai challenge at200 is a refusal, never a product listing', () => {
    expect(
      isBlockedPage(200, '<script>triggerInterstitialChallenge({"bm-verify":true})</script>'),
    ).toBe(true);
  });
  it('fallback defaultfalse, strict boolean', () => {
    expect(parseConfig({}).telegram.useMainBotFallback).toBe(false);
    expect(() => parseConfig({ telegram: { useMainBotFallback: 'yes' } })).toThrow();
  });
  it('401 retries once by explicit main bot, same recipient and text', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const notify = pricewatchNotifier({
      token: 'test-invalid',
      mainBotToken: 'test-main',
      chatId: '123',
      out: async () => undefined,
      log,
      send: (async (u, init) => {
        calls.push({ url: String(u), body: String(init?.body) });
        return new Response('', { status: calls.length === 1 ? 401 : 200 });
      }) as typeof fetch,
    });
    await notify('Posible error de precio (sospecha)');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('bottest-main/');
    expect(calls[1]?.body).toBe(calls[0]?.body);
  });
  it('disabled fallback and403 do not change sender or retry', async () => {
    for (const [status, fallback] of [
      [401, ''],
      [403, 'test-main'],
    ] as const) {
      let count = 0;
      await pricewatchNotifier({
        token: 'test-primary',
        mainBotToken: fallback,
        chatId: '123',
        out: async () => undefined,
        log,
        send: (async () => {
          count++;
          return new Response('', { status });
        }) as typeof fetch,
      })('Aviso');
      expect(count).toBe(1);
    }
  });
  it('disabled config and disallowed URL never launch a browser', async () => {
    let launched = 0;
    const reader = new PublicPriceBrowser(async () => {
      launched++;
      throw new Error('must not launch');
    });
    expect((await reader.read('https://localhost/', async () => true)).status).toBe(403);
    await reader.close();
    expect(launched).toBe(0);
  });
});

it('public browser reuses launch per cycle, counts requests, closes pages, and stops challenge', async () => {
  let launches = 0;
  let closed = 0;
  let contextsClosed = 0;
  let requests = 0;
  let fetched = 0;
  let challenge = false;
  const fakeBrowser = {
    newContext: async () => {
      let routeHandler: (r: unknown) => Promise<void>;
      return {
        route: async (_: string, fn: (r: unknown) => Promise<void>) => {
          routeHandler = fn;
        },
        newPage: async () => ({
          goto: async (url: string) => {
            await routeHandler({
              request: () => ({ url: () => url, resourceType: () => 'document' }),
              abort: async () => undefined,
              fulfill: async () => undefined,
              fetch: async () => {
                fetched++;
                return {
                  status: () => 200,
                  text: async () =>
                    challenge ? 'triggerInterstitialChallenge bm-verify' : '<html>product</html>',
                };
              },
            });
            return { status: () => 200 };
          },
          waitForLoadState: async () => undefined,
          content: async () => '<html>product</html>',
        }),
        close: async () => {
          contextsClosed++;
        },
      };
    },
    close: async () => {
      closed++;
    },
  };
  const { PublicPriceBrowser } = await import('../src/watch/pricewatch-browser.js');
  const reader = new PublicPriceBrowser(async () => {
    launches++;
    return fakeBrowser as unknown as import('playwright').Browser;
  });
  const permit = async () => {
    requests++;
    return true;
  };
  expect((await reader.read('https://www.amazon.es/s?k=tv', permit)).status).toBe(200);
  challenge = true;
  expect((await reader.read('https://www.amazon.es/s?k=tv', permit)).status).toBe(403);
  expect(launches).toBe(1);
  expect(requests).toBe(2);
  expect(fetched).toBe(2);
  await reader.close();
  expect(closed).toBe(1);
  expect(contextsClosed).toBe(2);
  expect((await reader.read('https://www.amazon.es/s?k=tv', async () => false)).status).toBe(403);
  expect(launches).toBe(2);
  expect(fetched).toBe(2);
  await reader.close();
});
