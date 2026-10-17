import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { createWebTool } from '../src/tools/web.js';
import { createTinyfishBackend, parseDuckDuckGoHtml } from '../src/web/backends.js';
import {
  aggregateMetrics,
  readMetrics,
  type WebBackend,
  type WebMetric,
  WebRouter,
} from '../src/web/router.js';

const root = mkdtempSync(join(tmpdir(), 'pa-web-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeBackend(over: Partial<WebBackend> & { id: string }): WebBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    ops: ['search', 'fetch'],
    costPerCallEur: 0,
    calls,
    search: async () => {
      calls.push('search');
      return { items: [{ title: 't', url: 'https://ejemplo.es', snippet: 's' }], chars: 10 };
    },
    fetch: async () => {
      calls.push('fetch');
      return { text: 'contenido', chars: 9, status: 200 };
    },
    ...over,
  } as WebBackend & { calls: string[] };
}

describe('WebRouter: fallback entre backends gratis', () => {
  it('usa el primero si funciona y no toca el segundo', async () => {
    const a = fakeBackend({ id: 'a' });
    const b = fakeBackend({ id: 'b' });
    const router = new WebRouter({ backends: [a, b] });
    const r = await router.routeSearch('astrofisica');
    expect(r.via).toBe('a');
    expect(b.calls).toEqual([]);
  });

  it('cae al siguiente cuando el primero falla y registra los intentos', async () => {
    const a = fakeBackend({
      id: 'a',
      search: async () => {
        throw new Error('429');
      },
    });
    const b = fakeBackend({ id: 'b' });
    const router = new WebRouter({ backends: [a, b] });
    const r = await router.routeSearch('astrofisica');
    expect(r.via).toBe('b');
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]).toMatchObject({ backend: 'a', ok: false });
    expect(r.attempts[1]).toMatchObject({ backend: 'b', ok: true });
  });

  it('falla en claro cuando TODOS fallan, diciendo que no se ha cobrado', async () => {
    const a = fakeBackend({
      id: 'a',
      fetch: async () => {
        throw new Error('500');
      },
    });
    const router = new WebRouter({ backends: [a] });
    await expect(router.routeFetch('https://ejemplo.es')).rejects.toThrow(/dentro del tope/);
  });

  it('rechaza resultados vacios y pasa al siguiente backend', async () => {
    const a = fakeBackend({ id: 'a', search: async () => ({ items: [], chars: 0 }) });
    const b = fakeBackend({ id: 'b' });
    const router = new WebRouter({ backends: [a, b] });
    const r = await router.routeSearch('x');
    expect(r.via).toBe('b');
  });
});

describe('WebRouter: tope €0 fail-closed', () => {
  it('un backend con coste > 0 NUNCA se llama con el tope en 0', async () => {
    const dePago = fakeBackend({ id: 'pago', costPerCallEur: 0.01 });
    const gratis = fakeBackend({ id: 'gratis' });
    const router = new WebRouter({ backends: [dePago, gratis], maxCostEur: 0 });
    const r = await router.routeSearch('precio vuelo');
    expect(r.via).toBe('gratis');
    expect(dePago.calls).toEqual([]);
  });

  it('un coste invalido (NaN, negativo, Infinity) cierra el paso igualmente', async () => {
    for (const costPerCallEur of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const raro = fakeBackend({ id: 'raro', costPerCallEur });
      const gratis = fakeBackend({ id: 'gratis' });
      const router = new WebRouter({ backends: [raro, gratis], maxCostEur: 0 });
      const r = await router.routeSearch('x');
      expect(r.via).toBe('gratis');
      expect(raro.calls).toEqual([]);
    }
  });

  it('sin ningun backend dentro del tope: error claro, cero llamadas', async () => {
    const dePago = fakeBackend({ id: 'pago', costPerCallEur: 0.5 });
    const router = new WebRouter({ backends: [dePago], maxCostEur: 0 });
    await expect(router.routeSearch('x')).rejects.toThrow(/dentro del tope/);
    expect(dePago.calls).toEqual([]);
  });
});

describe('WebRouter: medicion', () => {
  it('escribe JSONL por intento con latencia, chars, tokens estimados y coste', async () => {
    const metricsPath = join(root, 'm1.jsonl');
    const a = fakeBackend({
      id: 'a',
      search: async () => {
        throw new Error('boom');
      },
    });
    const b = fakeBackend({ id: 'b' });
    const router = new WebRouter({ backends: [a, b], metricsPath });
    await router.routeSearch('metricas', { host: 'ejemplo.es' });
    const lines = await readMetrics(metricsPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ op: 'search', backend: 'a', ok: false, costEur: 0 });
    expect(lines[1]).toMatchObject({ op: 'search', backend: 'b', ok: true, chars: 10 });
    expect(lines[1]?.estTokens).toBe(Math.ceil(10 / 4));
    expect(lines[1]?.host).toBe('ejemplo.es');
    // La metrica nunca guarda la query ni la URL completa.
    expect(JSON.stringify(lines)).not.toContain('metricas');
  });

  it('readMetrics tolera lineas corruptas y archivo ausente', async () => {
    expect(await readMetrics(join(root, 'no-existe.jsonl'))).toEqual([]);
    const p = join(root, 'm2.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      p,
      '{"ts":"t","op":"search","backend":"a","ok":true,"latencyMs":5,"chars":1,"estTokens":1,"costEur":0}\nesto no es json\n',
    );
    const lines = await readMetrics(p);
    expect(lines).toHaveLength(1);
  });

  it('aggregateMetrics agrupa por op+backend con p50/p95', () => {
    const mk = (backend: string, latencyMs: number, ok = true): WebMetric => ({
      ts: '2026-10-17T00:00:00.000Z',
      op: 'fetch',
      backend,
      ok,
      latencyMs,
      chars: 100,
      estTokens: 25,
      costEur: 0,
    });
    const stats = aggregateMetrics([mk('a', 100), mk('a', 200), mk('a', 300), mk('b', 50, false)]);
    const a = stats.find((s) => s.backend === 'a');
    expect(a).toMatchObject({ op: 'fetch', calls: 3, ok: 3, okPct: 100, p50Ms: 200 });
    const b = stats.find((s) => s.backend === 'b');
    expect(b).toMatchObject({ calls: 1, ok: 0, okPct: 0 });
  });
});

describe('backend tinyfish: parseo y errores', () => {
  it('mapea resultados de busqueda al formato comun', async () => {
    const backend = createTinyfishBackend({
      apiKey: 'clave-de-prueba',
      httpGet: async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            results: [
              { title: 'Uno', url: 'https://uno.es', snippet: 's1', site_name: 'uno.es' },
              { title: 'Dos', url: 'https://dos.es', snippet: 's2' },
            ],
          }),
      }),
    });
    const r = await backend.search?.('consulta', { maxResults: 5 });
    expect(r?.items).toHaveLength(2);
    expect(r?.items[0]).toMatchObject({ title: 'Uno', url: 'https://uno.es', siteName: 'uno.es' });
    expect(r?.chars).toBeGreaterThan(0);
  });

  it('un HTTP que no es 200 lanza error (el router hace fallback)', async () => {
    const backend = createTinyfishBackend({
      apiKey: 'clave-de-prueba',
      httpGet: async () => ({ status: 429, text: async () => '' }),
    });
    await expect(backend.search?.('x', { maxResults: 5 })).rejects.toThrow(/429/);
  });

  it('fetch usa el campo text y convierte errors[] en fallo', async () => {
    const ok = createTinyfishBackend({
      apiKey: 'clave-de-prueba',
      validateUrl: async () => true,
      httpPost: async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({ results: [{ url: 'https://x.es', text: '# Titulo\ncontenido' }] }),
      }),
    });
    const r = await ok.fetch?.('https://x.es', { maxChars: 1000 });
    expect(r?.text).toContain('Titulo');

    const fallo = createTinyfishBackend({
      apiKey: 'clave-de-prueba',
      validateUrl: async () => true,
      httpPost: async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            results: [{ url: 'https://x.es', text: null }],
            errors: [{ error: 'bot_blocked' }],
          }),
      }),
    });
    await expect(fallo.fetch?.('https://x.es', { maxChars: 1000 })).rejects.toThrow(/bot_blocked/);
  });

  it('la clave viaja en la cabecera X-API-Key y nunca en la URL', async () => {
    let seenUrl = '';
    let seenKey = '';
    const backend = createTinyfishBackend({
      apiKey: 'clave-secreta-123',
      httpGet: async (url, init) => {
        seenUrl = url;
        seenKey = init.headers['X-API-Key'] ?? '';
        return { status: 200, text: async () => JSON.stringify({ results: [] }) };
      },
    });
    await backend.search?.('q', { maxResults: 3 });
    expect(seenKey).toBe('clave-secreta-123');
    expect(seenUrl).not.toContain('clave-secreta-123');
  });
});

describe('backend tinyfish: la clave no sigue redirects (canario cross-origin)', () => {
  it('search y fetch piden redirect: manual y un 302 NO se sigue a otro origen', async () => {
    const vistos: Array<{ url: string; redirect?: string }> = [];
    const responder = async (url: string, init: { redirect?: string }) => {
      vistos.push({ url, redirect: init.redirect });
      // La API devuelve 302 hacia un host de atacante: con manual no se sigue.
      return { status: 302, text: async () => '' };
    };
    const backend = createTinyfishBackend({
      apiKey: 'clave-sintetica-canario',
      validateUrl: async () => true,
      httpGet: responder,
      httpPost: responder,
    });
    await expect(backend.search?.('q', { maxResults: 3 })).rejects.toThrow(/302/);
    await expect(backend.fetch?.('https://www.ejemplo.es', { maxChars: 100 })).rejects.toThrow(
      /302/,
    );
    // Dos llamadas (una por operacion), cero seguimientos al segundo origen.
    expect(vistos).toHaveLength(2);
    for (const v of vistos) {
      expect(v.redirect).toBe('manual');
      expect(v.url).not.toContain('atacante');
    }
  });

  it('fetch pide lectura en vivo: el body lleva ttl: 0', async () => {
    let body = '';
    const backend = createTinyfishBackend({
      apiKey: 'clave-sintetica-canario',
      validateUrl: async () => true,
      httpPost: async (_url, init) => {
        body = init.body;
        return {
          status: 200,
          text: async () =>
            JSON.stringify({ results: [{ url: 'https://x.es', text: 'contenido' }] }),
        };
      },
    });
    await backend.fetch?.('https://x.es', { maxChars: 100 });
    expect(JSON.parse(body)).toMatchObject({ ttl: 0 });
  });

  it('fetch valida la URL con la puerta SSRF aunque se invoque directo (sin tool ni router)', async () => {
    let llamadas = 0;
    const backend = createTinyfishBackend({
      apiKey: 'clave-sintetica-canario',
      httpPost: async () => {
        llamadas++;
        return { status: 200, text: async () => '{}' };
      },
    });
    await expect(
      backend.fetch?.('http://169.254.169.254/latest/meta-data', { maxChars: 100 }),
    ).rejects.toThrow(/http\(s\) publicas/);
    expect(llamadas).toBe(0);
  });
});

describe('WebRouter: puerta SSRF centralizada en routeFetch', () => {
  it('rechaza una URL privada antes de llamar a cualquier backend', async () => {
    const b = fakeBackend({ id: 'b' });
    const router = new WebRouter({ backends: [b] });
    await expect(router.routeFetch('http://127.0.0.1:8080/admin')).rejects.toThrow(
      /locales o privadas/,
    );
    expect(b.calls).toEqual([]);
  });

  it('respeta una validacion inyectada (fail-closed del consumidor)', async () => {
    const b = fakeBackend({ id: 'b' });
    const router = new WebRouter({ backends: [b], validateFetchUrl: async () => false });
    await expect(router.routeFetch('https://www.ejemplo.es')).rejects.toThrow(/http\(s\) publicas/);
    expect(b.calls).toEqual([]);
  });
});

describe('backend ddg: parser del HTML de duckduckgo', () => {
  const html = `
    <div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ejemplo.es%2Fpagina&amp;rut=x">Titulo <b>uno</b></a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Fragmento del <b>primer</b> resultado</a>
    </div>
    <div class="result results_links">
      <a class="result__a" href="https://directo.es/">Directo</a>
    </div>`;

  it('extrae titulo, URL (decodificando uddg) y snippet', () => {
    const items = parseDuckDuckGoHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Titulo uno',
      url: 'https://www.ejemplo.es/pagina',
      snippet: 'Fragmento del primer resultado',
    });
    expect(items[1]).toMatchObject({ title: 'Directo', url: 'https://directo.es/' });
  });

  it('ignora enlaces que no son http(s)', () => {
    const mal = `<div class="result results_links"><a class="result__a" href="javascript:alert(1)">x</a></div>`;
    expect(parseDuckDuckGoHtml(mal)).toEqual([]);
  });
});

describe('tool web (integracion con backends falsos)', () => {
  function toolWith(backends: WebBackend[], metricsPath?: string) {
    return createWebTool(
      { webMaxCostEur: 0 },
      { buildBackends: async () => backends, metricsPath: metricsPath ?? join(root, 'tool.jsonl') },
    );
  }

  it('search devuelve lista numerada con la fuente y el backend usado', async () => {
    const tool = toolWith([fakeBackend({ id: 'falso' })]);
    const res = await tool.execute('1', { action: 'search', query: 'horario renfe' });
    const body = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(body).toContain('via falso');
    expect(body).toContain('1. t');
    expect(res.details).toMatchObject({ via: 'falso', items: 1 });
  });

  it('search sin query falla en claro', async () => {
    const tool = toolWith([fakeBackend({ id: 'falso' })]);
    await expect(tool.execute('1', { action: 'search' })).rejects.toThrow(/query/);
  });

  it('fetch rechaza URLs privadas antes de tocar ningun backend', async () => {
    const b = fakeBackend({ id: 'falso' });
    const tool = toolWith([b]);
    await expect(
      tool.execute('1', { action: 'fetch', url: 'http://169.254.169.254/latest/meta-data' }),
    ).rejects.toThrow(/locales o privadas/);
    expect(b.calls).toEqual([]);
  });

  it('fetch devuelve el contenido vallado con el backend usado', async () => {
    const tool = toolWith([fakeBackend({ id: 'falso' })]);
    const res = await tool.execute('1', { action: 'fetch', url: 'https://www.ejemplo.es' });
    const body = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(body).toContain('<fetched_content source="https://www.ejemplo.es" backend="falso">');
    expect(body).toContain('contenido');
  });

  it('stats sin medicion dice que aun no hay; con medicion resume por backend', async () => {
    const vacio = toolWith([fakeBackend({ id: 'falso' })], join(root, 'vacio.jsonl'));
    const r1 = await vacio.execute('1', { action: 'stats' });
    expect(r1.content[0]?.type === 'text' && r1.content[0].text).toContain('Todavia no hay');

    const metricsPath = join(root, 'con-datos.jsonl');
    const tool = toolWith([fakeBackend({ id: 'falso' })], metricsPath);
    await tool.execute('1', { action: 'search', query: 'x' });
    const r2 = await tool.execute('1', { action: 'stats' });
    const body = r2.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(body).toContain('search via falso');
    expect(body).toContain('100% ok');
    expect(body).toContain('Coste declarado total: 0 €');
  });
});

describe('config: PA_WEB_MAX_COST_EUR', () => {
  it('por defecto es 0 y un valor invalido rompe el arranque', () => {
    delete process.env.PA_WEB_MAX_COST_EUR;
    resetConfigForTests();
    expect(loadConfig().webMaxCostEur).toBe(0);

    process.env.PA_WEB_MAX_COST_EUR = '-1';
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/PA_WEB_MAX_COST_EUR/);
    delete process.env.PA_WEB_MAX_COST_EUR;
    resetConfigForTests();
  });
});
