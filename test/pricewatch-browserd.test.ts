import { describe, expect, it } from 'vitest';
import { BrowserdClient, BrowserdError } from '../src/browser/browserd-client.js';
import {
  browserEngine,
  CamoufoxPriceBrowser,
  createPricePageReader,
  FallbackPriceBrowser,
  type PricePageReader,
} from '../src/watch/pricewatch-browserd.js';

type FakeRoute = { status?: number; body?: unknown; fail?: boolean };
function fakeBrowserd(routes: Record<string, FakeRoute>) {
  const calls: string[] = [];
  const fetchFn = (async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string> },
  ) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(
      `${method} ${url} auth=${(init?.headers as Record<string, string>)?.authorization ?? ''}`,
    );
    const key = `${method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) return new Response('{}', { status: 404 });
    if (route.fail) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const AMAZON = 'https://www.amazon.es/s?k=tv';
const allow = async () => true;
const deny = async () => false;

describe('browserEngine flag', () => {
  it('defaults to playwright, camoufox solo con el valor exacto', () => {
    expect(browserEngine({} as NodeJS.ProcessEnv)).toBe('playwright');
    expect(browserEngine({ BROWSER_ENGINE: 'camoufox' } as NodeJS.ProcessEnv)).toBe('camoufox');
    expect(browserEngine({ BROWSER_ENGINE: 'CAMOUFOX' } as NodeJS.ProcessEnv)).toBe('camoufox');
    expect(browserEngine({ BROWSER_ENGINE: 'chrome' } as NodeJS.ProcessEnv)).toBe('playwright');
  });
  it('createPricePageReader devuelve el fallback salvo flag camoufox', () => {
    const fb: PricePageReader = {
      read: async () => ({ status: 200, html: '' }),
      close: async () => undefined,
    };
    expect(createPricePageReader(fb, {} as NodeJS.ProcessEnv)).toBe(fb);
    expect(
      createPricePageReader(fb, { BROWSER_ENGINE: 'camoufox' } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(FallbackPriceBrowser);
  });
});

describe('CamoufoxPriceBrowser', () => {
  const routesOk: Record<string, FakeRoute> = {
    'POST /sessions': { body: { id: 's1' } },
    'POST /sessions/s1/goto': { body: { status: 200, url: AMAZON, title: 'Amazon' } },
    'POST /sessions/s1/evaluate': {
      body: { value: '<html><body>Ofertas de televisores</body></html>' },
    },
  };
  it('lee status+html via sesion persistente (una sola sesion para dos lecturas)', async () => {
    const { fetchFn, calls } = fakeBrowserd(routesOk);
    const b = new CamoufoxPriceBrowser(
      new BrowserdClient({ baseUrl: 'http://127.0.0.1:7701', fetchFn }),
    );
    const r1 = await b.read(AMAZON, allow);
    const r2 = await b.read(AMAZON, allow);
    expect(r1.status).toBe(200);
    expect(r1.html).toContain('televisores');
    expect(r2.status).toBe(200);
    expect(calls.filter((c) => c.startsWith('POST http://127.0.0.1:7701/sessions '))).toHaveLength(
      1,
    );
  });
  it('rechaza hosts fuera de la allowlist sin tocar el sidecar', async () => {
    const { fetchFn, calls } = fakeBrowserd(routesOk);
    const b = new CamoufoxPriceBrowser(
      new BrowserdClient({ baseUrl: 'http://127.0.0.1:7701', fetchFn }),
    );
    const r = await b.read('https://www.fnac.es/s/tv', allow);
    expect(r).toEqual({ status: 403, html: '' });
    expect(calls).toHaveLength(0);
  });
  it('permit=false corta antes de navegar', async () => {
    const { fetchFn, calls } = fakeBrowserd(routesOk);
    const b = new CamoufoxPriceBrowser(
      new BrowserdClient({ baseUrl: 'http://127.0.0.1:7701', fetchFn }),
    );
    const r = await b.read(AMAZON, deny);
    expect(r).toEqual({ status: 403, html: '' });
    expect(calls).toHaveLength(0);
  });
  it('pagina de challenge con 200 se clasifica como bloqueo (403, html vacio)', async () => {
    const { fetchFn } = fakeBrowserd({
      ...routesOk,
      'POST /sessions/s1/evaluate': {
        body: { value: '<script>triggerInterstitialChallenge({"bm-verify":1})</script>' },
      },
    });
    const b = new CamoufoxPriceBrowser(
      new BrowserdClient({ baseUrl: 'http://127.0.0.1:7701', fetchFn }),
    );
    const r = await b.read(AMAZON, allow);
    expect(r).toEqual({ status: 403, html: '' });
  });
  it('el token viaja SOLO en Authorization, nunca en la URL', async () => {
    const { fetchFn, calls } = fakeBrowserd(routesOk);
    const b = new CamoufoxPriceBrowser(
      new BrowserdClient({ baseUrl: 'http://127.0.0.1:7701', token: 'secreto', fetchFn }),
    );
    await b.read(AMAZON, allow);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).not.toContain('?');
      expect(c.split(' auth=')[0]).not.toContain('secreto');
    }
    expect(calls[0]).toContain('auth=Bearer secreto');
  });
});

describe('FallbackPriceBrowser', () => {
  function reader(fn: () => Promise<{ status: number; html: string }>): PricePageReader {
    return { read: fn, close: async () => undefined };
  }
  it('fallo de transporte del sidecar conmuta al fallback para el resto del ciclo', async () => {
    let fallbackCalls = 0;
    const primary = reader(async () => {
      throw new BrowserdError('browserd inalcanzable: ECONNREFUSED');
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
  it('un error que NO es de transporte (bug) no traga fallback: propaga', async () => {
    const primary = reader(async () => {
      throw new TypeError('bug interno');
    });
    const b = new FallbackPriceBrowser(
      primary,
      reader(async () => ({ status: 200, html: '' })),
      () => undefined,
    );
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
