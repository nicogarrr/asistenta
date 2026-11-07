import { describe, expect, it } from 'vitest';
import { helpCommands } from '../src/channels/telegram-help.js';
import {
  diagnosticoWda,
  WDA_URL_POR_DEFECTO,
  WdaClient,
  WdaError,
  type WdaFetch,
  wdaActivo,
  wdaUrl,
} from '../src/iphone/wda.js';
import { Gate } from '../src/permissions.js';
import { createIphonePantallaTool } from '../src/tools/iphone-pantalla.js';

// iPhone por WebDriverAgent (experimental, PA_IPHONE_WDA=1). Sin iPhone real: un WDA
// simulado que apunta cada petición. No se afirma que funcione en un teléfono.

type Llamada = { method: string; path: string; body?: unknown };
function wdaFalso(opts: { rechaza?: boolean; cuelga?: boolean; perderSesion?: boolean } = {}) {
  const llamadas: Llamada[] = [];
  let sesiones = 0;
  let perdida = opts.perderSesion ?? false;
  const f: WdaFetch = async (url, init) => {
    const path = url.replace('http://wda', '');
    const method = init?.method ?? 'GET';
    llamadas.push({ method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (opts.rechaza)
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (opts.cuelga) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const json = (v: unknown, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(v),
    });
    if (path === '/status') return json({ value: { ready: true, os: { version: '27.1' } } });
    if (path === '/screenshot') return json({ value: Buffer.from('png!').toString('base64') });
    if (path.startsWith('/source'))
      return json({ value: 'Button "Enviar" {{300, 700}, {80, 40}}' });
    if (path === '/session') {
      sesiones += 1;
      return json({ sessionId: `s${sesiones}` });
    }
    if (perdida && path.startsWith('/session/s1/')) {
      perdida = false;
      return json({ value: { message: 'invalid session id' } }, 404);
    }
    if (path.startsWith('/session/') || path === '/wda/homescreen') return json({ value: null });
    return json({ value: { message: 'no such route' } }, 404);
  };
  return { f, llamadas, cliente: new WdaClient({ baseUrl: 'http://wda', fetch: f }) };
}

describe('configuración', () => {
  it('solo se activa con PA_IPHONE_WDA=1', () => {
    expect(wdaActivo({})).toBe(false);
    expect(wdaActivo({ PA_IPHONE_WDA: '0' })).toBe(false);
    expect(wdaActivo({ PA_IPHONE_WDA: ' 1 ' })).toBe(true);
  });
  it('URL de WDA: la del .env si es válida; si no, la de por defecto', () => {
    expect(wdaUrl({})).toBe(WDA_URL_POR_DEFECTO);
    expect(wdaUrl({ PA_IPHONE_WDA_URL: 'http://100.64.1.2:8100/' })).toBe('http://100.64.1.2:8100');
    expect(wdaUrl({ PA_IPHONE_WDA_URL: 'file:///etc' })).toBe(WDA_URL_POR_DEFECTO);
  });
});

describe('WdaClient', () => {
  it('toca y escribe dentro de una sesión, que se abre una vez', async () => {
    const { cliente, llamadas } = wdaFalso();
    await cliente.tocar(310, 720);
    await cliente.escribir('hola');
    expect(llamadas.filter((l) => l.path === '/session')).toHaveLength(1);
    expect(llamadas).toContainEqual({
      method: 'POST',
      path: '/session/s1/wda/tap',
      body: { x: 310, y: 720 },
    });
    expect(llamadas).toContainEqual({
      method: 'POST',
      path: '/session/s1/wda/keys',
      body: { value: ['h', 'o', 'l', 'a'] },
    });
  });

  it('si WDA perdió la sesión, abre otra una vez y repite', async () => {
    const { cliente, llamadas } = wdaFalso({ perderSesion: true });
    await cliente.abrir('net.whatsapp.WhatsApp');
    expect(llamadas.filter((l) => l.path === '/session')).toHaveLength(2);
    expect(llamadas.at(-1)).toEqual({
      method: 'POST',
      path: '/session/s2/wda/apps/launch',
      body: { bundleId: 'net.whatsapp.WhatsApp' },
    });
  });

  it('conexión rechazada = no enviado; sin respuesta = desconocido (mirar antes de repetir)', async () => {
    await expect(wdaFalso({ rechaza: true }).cliente.tocar(1, 1)).rejects.toMatchObject({
      entrega: 'no-enviado',
    });
    const e = await wdaFalso({ cuelga: true })
      .cliente.estado()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WdaError);
    expect((e as WdaError).entrega).toBe('desconocido');
    expect((e as WdaError).message).toContain('Mira la pantalla');
  });
});

describe('herramienta iphone_pantalla', () => {
  it('pantalla devuelve la imagen; leer, el árbol', async () => {
    const { cliente } = wdaFalso();
    const tool = createIphonePantallaTool(() => cliente);
    const p = await tool.execute('t', { action: 'pantalla' } as never);
    expect(p.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const l = await tool.execute('t', { action: 'leer' } as never);
    expect((l.content[0] as { text: string }).text).toContain('Enviar');
  });

  it('un fallo dice si se hizo o no, sin lanzar', async () => {
    const tool = createIphonePantallaTool(() => wdaFalso({ cuelga: true }).cliente);
    const r = await tool.execute('t', { action: 'tocar', x: 5, y: 5 } as never);
    expect((r.content[0] as { text: string }).text).toMatch(/^Sin saber si se ha hecho/);
    const tool2 = createIphonePantallaTool(() => wdaFalso({ rechaza: true }).cliente);
    const r2 = await tool2.execute('t', { action: 'tocar', x: 5, y: 5 } as never);
    expect((r2.content[0] as { text: string }).text).toMatch(/^No se ha hecho/);
  });

  it('valida lo que falta antes de tocar el teléfono', async () => {
    const { cliente, llamadas } = wdaFalso();
    const tool = createIphonePantallaTool(() => cliente);
    await tool.execute('t', { action: 'tocar' } as never);
    await tool.execute('t', { action: 'abrir', bundleId: 'a b; rm' } as never);
    expect(llamadas).toEqual([]);
  });

  it('la Gate pregunta cada toque, texto, app o inicio; mirar es lectura', () => {
    const gate = new Gate();
    const c = (action: string) =>
      gate.classifyEffect({ tool: 'iphone_pantalla', args: { action }, actor: 'test' });
    for (const a of ['tocar', 'escribir', 'abrir', 'inicio']) expect(c(a), a).toBeNull();
    for (const a of ['estado', 'pantalla', 'leer']) expect(c(a), a).toBe('lee');
  });
});

describe('/iphone diagnostico', () => {
  it('sale en /help', () => {
    expect(helpCommands()).toContain('iphone');
  });
  it('apagado: dice qué poner en .env', async () => {
    const t = await diagnosticoWda({}, wdaFalso().cliente);
    expect(t).toContain('PA_IPHONE_WDA=1');
  });
  it('encendido y sin WDA: dice el siguiente paso', async () => {
    const t = await diagnosticoWda({ PA_IPHONE_WDA: '1' }, wdaFalso({ rechaza: true }).cliente);
    expect(t).toContain('❌');
    expect(t).toContain('docs/iphone-wda.md');
  });
  it('encendido y con WDA: iOS y pantalla', async () => {
    const t = await diagnosticoWda({ PA_IPHONE_WDA: '1' }, wdaFalso().cliente);
    expect(t).toContain('iOS 27.1');
    expect(t).toContain('Pantalla: ok');
  });
});
