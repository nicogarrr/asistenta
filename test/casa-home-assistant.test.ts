/**
 * Home Assistant local con permiso en cada acción. Todo con fetch falso.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Gate } from '../src/permissions.js';
import { CASA_NOT_SET, createCasaTool, isHomeUrl } from '../src/tools/casa.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

type Call = { url: string; method: string; body: string | undefined; auth: string | undefined };

function fakeFetch(answers: Record<string, unknown>, status = 200) {
  const calls: Call[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
      auth: headers.authorization,
    });
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(answers[path] ?? []), { status });
  }) as typeof fetch;
  return { fn, calls };
}

const cfg = async () => ({ url: 'http://192.168.1.20:8123', token: 'tok-123' });

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((p) => p.text ?? '').join('\n');
}

describe('casa (Home Assistant)', () => {
  it('solo usa direcciones de la red de casa', () => {
    expect(isHomeUrl('http://192.168.1.20:8123')).toBe(true);
    expect(isHomeUrl('http://homeassistant.local:8123')).toBe(true);
    expect(isHomeUrl('http://10.0.0.5')).toBe(true);
    expect(isHomeUrl('https://mi-casa.duckdns.org')).toBe(false);
    expect(isHomeUrl('http://8.8.8.8')).toBe(false);
    expect(isHomeUrl('http://user:pw@192.168.1.2')).toBe(false);
    expect(isHomeUrl('file:///etc/passwd')).toBe(false);
  });

  it('sin configurar lo dice claro y no llama a nada', async () => {
    const { fn, calls } = fakeFetch({});
    const tool = createCasaTool({ config: async () => null, fetch: fn });
    expect(text(await tool.execute('1', { action: 'estado' }, undefined, undefined))).toBe(
      CASA_NOT_SET,
    );
    const pub = createCasaTool({
      config: async () => ({ url: 'https://casa.example.com', token: 't' }),
      fetch: fn,
    });
    expect(text(await pub.execute('2', { action: 'estado' }, undefined, undefined))).toContain(
      'no la uso',
    );
    expect(calls).toHaveLength(0);
  });

  it('estado lista luces, enchufes y ventiladores en una línea corta', async () => {
    const { fn, calls } = fakeFetch({
      '/api/states': [
        { entity_id: 'light.salon', state: 'on', attributes: { friendly_name: 'Salón' } },
        { entity_id: 'switch.cafetera', state: 'off', attributes: {} },
        { entity_id: 'sensor.temperatura', state: '21' },
      ],
    });
    const tool = createCasaTool({ config: cfg, fetch: fn });
    const out = text(await tool.execute('3', { action: 'estado' }, undefined, undefined));
    expect(out).toBe('Salón (light.salon): encendido; switch.cafetera: apagado');
    expect(calls[0]?.auth).toBe('Bearer tok-123');
    expect(out).not.toContain('tok-123');
  });

  it('encender llama al servicio correcto y solo para luces, enchufes y ventiladores', async () => {
    const { fn, calls } = fakeFetch({});
    const tool = createCasaTool({ config: cfg, fetch: fn });
    const ok = await tool.execute(
      '4',
      { action: 'encender', entidad: 'light.salon' },
      undefined,
      undefined,
    );
    expect(text(ok)).toBe('Encendido: light.salon.');
    expect(calls[0]?.url).toBe('http://192.168.1.20:8123/api/services/light/turn_on');
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ entity_id: 'light.salon' });
    const lock = await tool.execute(
      '5',
      { action: 'apagar', entidad: 'lock.puerta' },
      undefined,
      undefined,
    );
    expect(text(lock)).toContain('Solo puedo');
    const weird = await tool.execute(
      '6',
      { action: 'apagar', entidad: '../../api/config' },
      undefined,
      undefined,
    );
    expect(text(weird)).toContain('No encuentro');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('acepta el nombre del aparato («la luz del salón») y pregunta si hay varios', async () => {
    const { fn, calls } = fakeFetch({
      '/api/states': [
        { entity_id: 'light.salon', state: 'off', attributes: { friendly_name: 'Salón' } },
        {
          entity_id: 'light.cocina_techo',
          state: 'on',
          attributes: { friendly_name: 'Cocina techo' },
        },
        {
          entity_id: 'light.cocina_isla',
          state: 'unavailable',
          attributes: { friendly_name: 'Cocina isla' },
        },
        { entity_id: 'lock.puerta', state: 'locked', attributes: { friendly_name: 'Puerta' } },
      ],
    });
    const tool = createCasaTool({ config: cfg, fetch: fn });
    const on = await tool.execute(
      'n1',
      { action: 'encender', entidad: 'la luz del Salón' },
      undefined,
      undefined,
    );
    expect(text(on)).toBe('Encendido: light.salon.');
    expect(calls.at(-1)?.url).toBe('http://192.168.1.20:8123/api/services/light/turn_on');
    const two = text(
      await tool.execute('n2', { action: 'apagar', entidad: 'cocina' }, undefined, undefined),
    );
    expect(two).toContain('Hay varios');
    expect(two).toContain('Cocina isla (light.cocina_isla): no disponible');
    const door = text(
      await tool.execute('n3', { action: 'apagar', entidad: 'puerta' }, undefined, undefined),
    );
    expect(door).toContain('No encuentro');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('un token malo o un fallo de red se dicen en castellano sin el error crudo', async () => {
    const bad = createCasaTool({ config: cfg, fetch: fakeFetch({}, 401).fn });
    expect(text(await bad.execute('7', { action: 'estado' }, undefined, undefined))).toContain(
      'no acepta el token',
    );
    const down = createCasaTool({
      config: cfg,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const out = text(await down.execute('8', { action: 'estado' }, undefined, undefined));
    expect(out).toContain('No he podido hablar con Home Assistant');
    expect(out).not.toContain('fetch failed');
  });

  it('la Gate pregunta en cada encender/apagar, incluso con la herramienta permitida', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['casa'],
      approver: () => {
        asked += 1;
        return true;
      },
    });
    const on = {
      tool: 'casa',
      args: { action: 'encender', entidad: 'light.salon' },
      actor: 'local',
    } as const;
    await gate.check('s', on);
    gate.settle('s', on, false);
    await gate.check('s', on);
    expect(asked).toBe(2);
    const look = { tool: 'casa', args: { action: 'estado' }, actor: 'local' } as const;
    expect((await gate.check('s', look)).verdict).toBe('allow');
    expect(asked).toBe(2);
  });

  it('cli.ts solo carga la herramienta con PA_HA_URL', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/process\.env\.PA_HA_URL\?\.trim\(\)\s*\?\s*\[\s*createCasaTool\(/);
  });
});
