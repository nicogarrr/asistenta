import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import {
  assertGlasshouseEndpoint,
  GlasshouseClient,
  GlasshouseError,
} from '../src/tv/glasshouse.js';

/* ---------- endpoint guard ---------- */

describe('assertGlasshouseEndpoint', () => {
  it('acepta LAN y tailnet, normaliza sin barra final', () => {
    expect(assertGlasshouseEndpoint('http://192.168.1.237:8080')).toBe('http://192.168.1.237:8080');
    expect(assertGlasshouseEndpoint('http://100.126.88.124:8080/')).toBe(
      'http://100.126.88.124:8080',
    );
    expect(assertGlasshouseEndpoint('  http://10.0.0.5:8080 ')).toBe('http://10.0.0.5:8080');
  });
  it('rechaza https, hosts publicos, credenciales, path y query', () => {
    for (const bad of [
      'https://192.168.1.237:8080',
      'http://8.8.8.8:8080',
      'http://example.com:8080',
      'http://user:pass@192.168.1.237:8080',
      'http://192.168.1.237:8080/api',
      'http://192.168.1.237:8080?k=1',
      'no-es-url',
      'http://100.20.1.1:8080', // fuera de 100.64/10
    ]) {
      expect(() => assertGlasshouseEndpoint(bad), bad).toThrow();
    }
  });
});

/* ---------- cliente ---------- */

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(
  handlers: ((url: string) => { status?: number; body?: string; throwNet?: boolean })[],
) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const h of handlers) {
      const r = h(u);
      if (r.throwNet) throw new Error('connect ECONNREFUSED');
      return new Response(r.body ?? '{"ok":true}', { status: r.status ?? 200 });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('GlasshouseClient.control', () => {
  it('envia POST JSON con action/value y Bearer si hay token', async () => {
    const { calls, fetchImpl } = mockFetch([() => ({ body: '{"ok":true}' })]);
    const c = new GlasshouseClient({
      endpoints: ['http://192.168.1.237:8080'],
      token: 'secreto',
      fetchImpl,
    });
    const r = await c.control('volume', 13);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const c0 = calls[0] as FetchCall;
    expect(c0.url).toBe('http://192.168.1.237:8080/api/control');
    expect(c0.init?.method).toBe('POST');
    const headers = c0.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer secreto');
    expect(JSON.parse(String(c0.init?.body))).toEqual({ action: 'volume', value: 13 });
  });

  it('ok:false es respuesta de la tele: error legible y SIN salto de endpoint', async () => {
    const { calls, fetchImpl } = mockFetch([
      () => ({ body: '{"ok":false,"error":"power actions disabled (set allowPower)"}' }),
    ]);
    const c = new GlasshouseClient({
      endpoints: ['http://192.168.1.237:8080', 'http://100.126.88.124:8080'],
      fetchImpl,
    });
    await expect(c.control('powerOff')).rejects.toThrow(/power actions disabled/);
    expect(calls).toHaveLength(1); // no reintento en el segundo endpoint
  });

  it('error de red salta al siguiente endpoint y lo deja sticky', async () => {
    let first = true;
    const { calls, fetchImpl } = mockFetch([
      () => {
        const fail = first;
        first = false;
        return fail ? { throwNet: true } : { body: '{"ok":true}' };
      },
    ]);
    const c = new GlasshouseClient({
      endpoints: ['http://192.168.1.237:8080', 'http://100.126.88.124:8080'],
      fetchImpl,
    });
    await c.control('mute', true);
    expect(calls.map((x) => x.url)).toEqual([
      'http://192.168.1.237:8080/api/control',
      'http://100.126.88.124:8080/api/control',
    ]);
    // sticky: la siguiente va directa al tailnet
    calls.length = 0;
    await c.control('mute', false);
    const s0 = calls[0] as FetchCall;
    expect(s0.url).toBe('http://100.126.88.124:8080/api/control');
  });

  it('todos los endpoints caidos: error que nombra la tele', async () => {
    const { fetchImpl } = mockFetch([() => ({ throwNet: true })]);
    const c = new GlasshouseClient({
      endpoints: ['http://192.168.1.237:8080', 'http://100.126.88.124:8080'],
      fetchImpl,
    });
    await expect(c.control('mute', true)).rejects.toThrow(/inalcanzable|apagada/);
  });

  it('accion con nombre invalido no llega a la red', async () => {
    const { calls, fetchImpl } = mockFetch([() => ({})]);
    const c = new GlasshouseClient({ endpoints: ['http://192.168.1.237:8080'], fetchImpl });
    await expect(c.control('volume; rm -rf')).rejects.toThrow(GlasshouseError);
    expect(calls).toHaveLength(0);
  });

  it('HTTP de error (401/403/500) no salta de endpoint', async () => {
    const { calls, fetchImpl } = mockFetch([() => ({ status: 403, body: '{"ok":false}' })]);
    const c = new GlasshouseClient({
      endpoints: ['http://192.168.1.237:8080', 'http://100.126.88.124:8080'],
      fetchImpl,
    });
    await expect(c.control('toast', 'hola')).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });

  it('respuesta no JSON es error, no exito', async () => {
    const { fetchImpl } = mockFetch([() => ({ body: '<html>dashboard</html>' })]);
    const c = new GlasshouseClient({ endpoints: ['http://192.168.1.237:8080'], fetchImpl });
    await expect(c.control('toast', 'hola')).rejects.toThrow(/JSON/);
  });
});

/* ---------- tool: acciones Glasshouse ---------- */

function deps(over: Partial<TvToolDeps> = {}): {
  deps: TvToolDeps;
  ghCalls: [string, unknown][];
} {
  const ghCalls: [string, unknown][] = [];
  const d: TvToolDeps = {
    shot: async () => ({ image: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: async () => [],
    launch: async () => {},
    key: async () => {},
    toast: async () => {},
    power: async () => {},
    saveFrame: () => '/tmp/tv-1.jpg',
    getState: () => null,
    setState: () => {},
    ghControl: async (action, value) => {
      ghCalls.push([action, value]);
    },
    ...over,
  };
  return { deps: d, ghCalls };
}

async function run(tool: ReturnType<typeof createTvTool>, args: Record<string, unknown>) {
  return tool.execute('t1', args as never);
}

describe('tool tv - acciones Glasshouse', () => {
  it('volume level=13 manda {volume,13}; "sube volumen a 13" cubierto', async () => {
    const { deps: d, ghCalls } = deps();
    const tool = createTvTool(d);
    await run(tool, { action: 'volume', level: 13 });
    expect(ghCalls).toEqual([['volume', 13]]);
  });
  it('volume sin level o fuera de rango: error claro, nada a la tele', async () => {
    const { deps: d, ghCalls } = deps();
    const tool = createTvTool(d);
    await expect(run(tool, { action: 'volume' })).rejects.toThrow(/level/);
    await expect(run(tool, { action: 'volume', level: 101 })).rejects.toThrow(/0-100/);
    await expect(run(tool, { action: 'volume', level: 13.5 })).rejects.toThrow(/entero/);
    expect(ghCalls).toHaveLength(0);
  });
  it('mute/screen/adTracking exigen on booleano', async () => {
    const { deps: d, ghCalls } = deps();
    const tool = createTvTool(d);
    await run(tool, { action: 'mute', on: true });
    await run(tool, { action: 'screen', on: false });
    await run(tool, { action: 'adTracking', on: true });
    expect(ghCalls).toEqual([
      ['mute', true],
      ['screenOff', undefined],
      ['limitAdTracking', true],
    ]);
    await expect(run(tool, { action: 'mute' })).rejects.toThrow(/on/);
  });
  it('input valida la lista y pasa el valor', async () => {
    const { deps: d, ghCalls } = deps();
    const tool = createTvTool(d);
    await run(tool, { action: 'input', input: 'HDMI2' });
    expect(ghCalls).toEqual([['input', 'hdmi2']]);
    await expect(run(tool, { action: 'input', input: 'component' })).rejects.toThrow(/hdmi1/);
  });
  it('url solo acepta http(s)', async () => {
    const { deps: d, ghCalls } = deps();
    const tool = createTvTool(d);
    await run(tool, { action: 'url', url: 'https://example.com' });
    expect(ghCalls).toEqual([['launchUrl', 'https://example.com']]);
    await expect(run(tool, { action: 'url', url: 'javascript:alert(1)' })).rejects.toThrow(/http/);
    await expect(run(tool, { action: 'url', url: 'file:///etc/passwd' })).rejects.toThrow(/http/);
  });
  it('media y adblock validan contra su lista', async () => {
    const { deps: d, ghCalls } = deps();
    const tool = createTvTool(d);
    await run(tool, { action: 'media', command: 'playPause' });
    await run(tool, { action: 'adblock', mode: 'ADS' });
    expect(ghCalls).toEqual([
      ['media', 'playPause'],
      ['setAdBlock', 'ads'],
    ]);
    await expect(run(tool, { action: 'media', command: 'eject' })).rejects.toThrow(/command/);
    await expect(run(tool, { action: 'adblock', mode: 'nuclear' })).rejects.toThrow(
      /off, ads, full/,
    );
  });
  it('closeApp exige appId', async () => {
    const { deps: d, ghCalls } = deps();
    const tool = createTvTool(d);
    await run(tool, { action: 'closeApp', appId: 'netflix' });
    expect(ghCalls).toEqual([['closeApp', 'netflix']]);
    await expect(run(tool, { action: 'closeApp' })).rejects.toThrow(/appId/);
  });
  it('sin ghControl configurado: error claro que nombra Glasshouse', async () => {
    const { deps: d } = deps({ ghControl: undefined });
    const tool = createTvTool(d);
    await expect(run(tool, { action: 'volume', level: 13 })).rejects.toThrow(/Glasshouse/);
  });
});
