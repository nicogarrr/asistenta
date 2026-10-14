import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserdClient, BrowserdError, BrowserdHttpError } from '../src/browser/browserd-client.js';
import {
  browserEngine,
  CamoufoxPriceBrowser,
  createPricePageReader,
  FallbackPriceBrowser,
  PUBLIC_STORE_HOSTS,
  type PricePageReader,
} from '../src/watch/pricewatch-browserd.js';

type FakeRoute = { status?: number; body?: unknown; failWith?: unknown };
function fakeBrowserd(routes: Record<string, FakeRoute>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchFn = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body });
    const key = `${method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) return new Response('{}', { status: 404 });
    if (route.failWith) throw route.failWith;
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const AMAZON = 'https://www.amazon.es/s?k=tv';
const allow = async () => true;
const deny = async () => false;

function clientWith(fetchFn: typeof fetch) {
  return new BrowserdClient({ baseUrl: 'http://127.0.0.1:7701', fetchFn });
}
const routesOk: Record<string, FakeRoute> = {
  'POST /sessions': { body: { id: 's1' } },
  'POST /sessions/s1/read': {
    body: { status: 200, url: AMAZON, title: 'Amazon', value: '<html><body>Ofertas de televisores</body></html>' },
  },
};

describe('browserEngine flag', () => {
  it('defaults to playwright, camoufox solo con el valor exacto', () => {
    expect(browserEngine({} as NodeJS.ProcessEnv)).toBe('playwright');
    expect(browserEngine({ BROWSER_ENGINE: 'camoufox' } as NodeJS.ProcessEnv)).toBe('camoufox');
    expect(browserEngine({ BROWSER_ENGINE: 'CAMOUFOX' } as NodeJS.ProcessEnv)).toBe('camoufox');
    expect(browserEngine({ BROWSER_ENGINE: 'chrome' } as NodeJS.ProcessEnv)).toBe('playwright');
  });
  it('createPricePageReader devuelve el fallback salvo flag camoufox', () => {
    const fb: PricePageReader = { read: async () => ({ status: 200, html: '' }), close: async () => undefined };
    expect(createPricePageReader(fb, {} as NodeJS.ProcessEnv)).toBe(fb);
    expect(createPricePageReader(fb, { BROWSER_ENGINE: 'camoufox' } as NodeJS.ProcessEnv)).toBeInstanceOf(FallbackPriceBrowser);
  });
});

describe('CamoufoxPriceBrowser', () => {
  it('read atomico lleva allowed_hosts de tiendas y permit_url loopback (barrera por request)', async () => {
    const { fetchFn, calls } = fakeBrowserd(routesOk);
    const b = new CamoufoxPriceBrowser(clientWith(fetchFn));
    const r = await b.read(AMAZON, allow);
    expect(r.status).toBe(200);
    const readCall = calls.find((c) => c.url.endsWith('/read'));
    const body = JSON.parse(readCall?.body ?? '{}');
    expect(body.allowed_hosts).toEqual([...PUBLIC_STORE_HOSTS]);
    expect(body.permit_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/permit\//);
    expect(body.expression).toContain('outerHTML');
    await b.close();
  });
  it('rechaza hosts fuera de la allowlist sin tocar el sidecar', async () => {
    const { fetchFn, calls } = fakeBrowserd(routesOk);
    const b = new CamoufoxPriceBrowser(clientWith(fetchFn));
    const r = await b.read('https://www.fnac.es/s/tv', allow);
    expect(r).toEqual({ status: 403, html: '' });
    expect(calls).toHaveLength(0);
    await b.close();
  });
  it('denied de la barrera del sidecar se propaga como 403 semantico', async () => {
    const { fetchFn } = fakeBrowserd({
      ...routesOk,
      'POST /sessions/s1/read': { body: { status: 403, url: '', title: '', value: null, denied: true } },
    });
    const b = new CamoufoxPriceBrowser(clientWith(fetchFn));
    expect(await b.read(AMAZON, deny)).toEqual({ status: 403, html: '' });
    await b.close();
  });
  it('pagina de challenge con 200 se clasifica como bloqueo (403, html vacio)', async () => {
    const { fetchFn } = fakeBrowserd({
      ...routesOk,
      'POST /sessions/s1/read': {
        body: { status: 200, url: AMAZON, title: '', value: '<script>triggerInterstitialChallenge({"bm-verify":1})</script>' },
      },
    });
    const b = new CamoufoxPriceBrowser(clientWith(fetchFn));
    expect(await b.read(AMAZON, allow)).toEqual({ status: 403, html: '' });
    await b.close();
  });
  it('HTTP no-2xx del sidecar (401 real del guard) NO dispara fallback: devuelve status 0', async () => {
    const { fetchFn } = fakeBrowserd({ 'POST /sessions': { status: 401, body: { detail: 'token invalido' } } });
    const b = new CamoufoxPriceBrowser(clientWith(fetchFn));
    expect(await b.read(AMAZON, allow)).toEqual({ status: 0, html: '' });
    await b.close();
  });
  it('el token viaja SOLO en Authorization, nunca en la URL', async () => {
    const { fetchFn, calls } = fakeBrowserd(routesOk);
    const b = new CamoufoxPriceBrowser(
      new BrowserdClient({ baseUrl: 'http://127.0.0.1:7701', token: 'secreto', fetchFn }),
    );
    await b.read(AMAZON, allow);
    for (const c of calls) expect(c.url).not.toContain('secreto');
    await b.close();
  });
});

describe('taxonomia de errores del cliente', () => {
  it('TypeError de red (con cause codificada) -> BrowserdError de transporte', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    const { fetchFn } = fakeBrowserd({ 'GET /health': { failWith: netErr } });
    await expect(clientWith(fetchFn).health()).rejects.toBeInstanceOf(BrowserdError);
  });
  it('TypeError de programacion (sin cause) PROPAGA intacto, nunca es transporte', async () => {
    const { fetchFn } = fakeBrowserd({ 'GET /health': { failWith: new TypeError('bug interno') } });
    await expect(clientWith(fetchFn).health()).rejects.toThrow(TypeError);
    await expect(clientWith(fetchFn).health()).rejects.not.toBeInstanceOf(BrowserdError);
  });
  it('HTTP no-2xx -> BrowserdHttpError (no transporte)', async () => {
    const { fetchFn } = fakeBrowserd({ 'GET /health': { status: 403, body: {} } });
    await expect(clientWith(fetchFn).health()).rejects.toBeInstanceOf(BrowserdHttpError);
    await expect(clientWith(fetchFn).health()).rejects.not.toBeInstanceOf(BrowserdError);
  });
  it('servidor que no responde: timeout end-to-end corta como transporte', async () => {
    const hanging: Server = createServer(() => undefined); // nunca responde
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', r));
    const port = (hanging.address() as AddressInfo).port;
    try {
      const c = new BrowserdClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 300 });
      await expect(c.health()).rejects.toBeInstanceOf(BrowserdError);
    } finally {
      hanging.close();
    }
  }, 10_000);
});

describe('FallbackPriceBrowser', () => {
  function reader(fn: () => Promise<{ status: number; html: string }>): PricePageReader {
    return { read: fn, close: async () => undefined };
  }
  it('fallo de transporte conmuta al fallback para el resto del ciclo (una vez log)', async () => {
    let fallbackCalls = 0;
    const primary = reader(async () => {
      throw new BrowserdError('browserd inalcanzable: fetch failed');
    });
    const fb = reader(async () => {
      fallbackCalls += 1;
      return { status: 200, html: '<html>playwright</html>' };
    });
    const logs: string[] = [];
    const b = new FallbackPriceBrowser(primary, fb, (m) => logs.push(m));
    const r1 = await b.read(AMAZON, allow);
    await b.read(AMAZON, allow);
    expect(r1.html).toContain('playwright');
    expect(fallbackCalls).toBe(2);
    expect(logs).toHaveLength(1);
  });
  it('un bug (no transporte) propaga sin fallback', async () => {
    const primary = reader(async () => {
      throw new TypeError('bug interno');
    });
    const b = new FallbackPriceBrowser(primary, reader(async () => ({ status: 200, html: '' })), () => undefined);
    await expect(b.read(AMAZON, allow)).rejects.toThrow('bug interno');
  });
  it('un 403 de bloqueo del sidecar NO dispara fallback', async () => {
    let primaryCalls = 0;
    const primary = reader(async () => {
      primaryCalls += 1;
      return { status: 403, html: '' };
    });
    let fallbackCalls = 0;
    const b = new FallbackPriceBrowser(
      primary,
      reader(async () => {
        fallbackCalls += 1;
        return { status: 200, html: '' };
      }),
      () => undefined,
    );
    await b.read(AMAZON, allow);
    await b.read(AMAZON, allow);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });
});

afterAll(() => {
  // los PermitHook se cierran en cada test via b.close()
});
