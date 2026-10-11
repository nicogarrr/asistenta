import { describe, expect, it } from 'vitest';
import { discoverBotHandle, extractBotHandles, invalidateBotCache } from '../src/books/discover.js';

const TELEGRAPH_HTML = `<html><body>
<p>Bot actual: <a href="https://t.me/BibliotecaSecretaBot">@BibliotecaSecretaBot</a></p>
<p>Canal de avisos: <a href="https://t.me/bibliotecasecreta">canal</a></p>
<p>Soporte: <a href="https://telegram.me/bs_soporte">contacto</a></p>
</body></html>`;

function fakeFetch(html: string, status = 200): typeof fetch {
  return (() => Promise.resolve(new Response(html, { status }))) as unknown as typeof fetch;
}

describe('extractBotHandles', () => {
  it('extrae solo handles que acaban en bot, no canales ni soporte', () => {
    expect(extractBotHandles(TELEGRAPH_HTML)).toEqual(['BibliotecaSecretaBot']);
  });
  it('sin handle devuelve lista vacia, nunca inventa', () => {
    expect(extractBotHandles('<p>sin enlaces</p>')).toEqual([]);
  });
});

describe('discoverBotHandle', () => {
  it('devuelve el handle y lo cachea', async () => {
    invalidateBotCache();
    let calls = 0;
    const f = (() => {
      calls += 1;
      return Promise.resolve(new Response(TELEGRAPH_HTML, { status: 200 }));
    }) as unknown as typeof fetch;
    const h1 = await discoverBotHandle({ fetchImpl: f, now: 1000 });
    const h2 = await discoverBotHandle({ fetchImpl: f, now: 1000 + 60_000 });
    expect(h1).toBe('BibliotecaSecretaBot');
    expect(h2).toBe(h1);
    expect(calls).toBe(1);
  });

  it('force=true ignora la cache (bot rotado)', async () => {
    invalidateBotCache();
    let calls = 0;
    const f = (() => {
      calls += 1;
      return Promise.resolve(new Response(TELEGRAPH_HTML, { status: 200 }));
    }) as unknown as typeof fetch;
    await discoverBotHandle({ fetchImpl: f, now: 1000 });
    await discoverBotHandle({ fetchImpl: f, force: true, now: 2000 });
    expect(calls).toBe(2);
  });

  it('cache expirada re-descubre', async () => {
    invalidateBotCache();
    let calls = 0;
    const f = (() => {
      calls += 1;
      return Promise.resolve(new Response(TELEGRAPH_HTML, { status: 200 }));
    }) as unknown as typeof fetch;
    await discoverBotHandle({ fetchImpl: f, now: 1000 });
    await discoverBotHandle({ fetchImpl: f, now: 1000 + 16 * 60 * 1000 });
    expect(calls).toBe(2);
  });

  it('HTTP no-ok es error explicito, nunca un handle inventado', async () => {
    invalidateBotCache();
    await expect(
      discoverBotHandle({ fetchImpl: fakeFetch('x', 502), force: true }),
    ).rejects.toThrow(/502/);
  });

  it('pagina sin handle de bot es error explicito', async () => {
    invalidateBotCache();
    await expect(
      discoverBotHandle({ fetchImpl: fakeFetch('<p>roto</p>'), force: true }),
    ).rejects.toThrow(/handle/);
  });
});
