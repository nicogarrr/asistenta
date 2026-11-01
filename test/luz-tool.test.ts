import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import {
  createLuzTool,
  euros,
  LUZ_AVISO_ROUTINE,
  LUZ_AVISO_SCHEDULE,
  parseLuzHours,
} from '../src/tools/luz.js';

// PVPC real del 1-nov-2026 (€/MWh), tal como lo devuelve apidatos.ree.es (recortado).
const NOV1: Array<[string, number]> = [
  ['2026-11-01T00:00:00.000+01:00', 274.95],
  ['2026-11-01T01:00:00.000+01:00', 278.08],
  ['2026-11-01T02:00:00.000+01:00', 275.61],
  ['2026-11-01T03:00:00.000+01:00', 271.34],
  ['2026-11-01T04:00:00.000+01:00', 268.97],
  ['2026-11-01T05:00:00.000+01:00', 269.59],
  ['2026-11-01T06:00:00.000+01:00', 269.68],
  ['2026-11-01T07:00:00.000+01:00', 280.82],
  ['2026-11-01T08:00:00.000+01:00', 234.42],
  ['2026-11-01T09:00:00.000+01:00', 83.63],
  ['2026-11-01T10:00:00.000+01:00', -8.1],
  ['2026-11-01T11:00:00.000+01:00', -7.92],
  ['2026-11-01T12:00:00.000+01:00', -3.75],
  ['2026-11-01T13:00:00.000+01:00', -2.43],
  ['2026-11-01T14:00:00.000+01:00', -2.64],
  ['2026-11-01T15:00:00.000+01:00', -1.36],
  ['2026-11-01T16:00:00.000+01:00', 14.6],
  ['2026-11-01T17:00:00.000+01:00', 173.01],
  ['2026-11-01T18:00:00.000+01:00', 271.04],
  ['2026-11-01T19:00:00.000+01:00', 286.83],
  ['2026-11-01T20:00:00.000+01:00', 297.88],
  ['2026-11-01T21:00:00.000+01:00', 297.62],
  ['2026-11-01T22:00:00.000+01:00', 280.35],
  ['2026-11-01T23:00:00.000+01:00', 262.16],
];

const reeBody = (rows: Array<[string, number]>) => ({
  data: { type: 'Precios mercado peninsular en tiempo real', id: 'mer13' },
  included: [
    {
      type: 'PVPC',
      id: '1001',
      attributes: { title: 'PVPC', values: rows.map(([datetime, value]) => ({ value, datetime })) },
    },
    {
      type: 'Precio mercado spot',
      id: '600',
      attributes: { title: 'Precio mercado spot', values: [{ value: 1, datetime: rows[0]?.[0] }] },
    },
  ],
});

const fake = (urls: string[], byDay: Record<string, Response | (() => Response)>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const day = new URL(u).searchParams.get('start_date')?.slice(0, 10) ?? '';
    const r = byDay[day];
    if (!r) return new Response(JSON.stringify({ errors: [{ status: '502' }] }), { status: 502 });
    return typeof r === 'function' ? r() : r;
  }) as typeof fetch;

const ok = (rows: Array<[string, number]>) => () =>
  new Response(JSON.stringify(reeBody(rows)), { status: 200 });

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

// 1-nov-2026 09:30 en Madrid (CET, UTC+1).
const at930 = () => new Date('2026-11-01T08:30:00Z');

describe('tool luz: «¿a qué hora pongo la lavadora?»', () => {
  it('lee la serie PVPC en €/kWh y descarta lo demás', () => {
    const hours = parseLuzHours(reeBody(NOV1));
    expect(hours).toHaveLength(24);
    expect(hours[9]?.price).toBeCloseTo(0.08363, 5);
    expect(parseLuzHours({ errors: [] })).toEqual([]);
    expect(euros(0.08363)).toBe('0,084 €/kWh');
    expect(euros(-0.0081)).toBe('-0,008 €/kWh');
  });

  it('hoy: precio ahora, la más barata y la más cara, tramos baratos y media', async () => {
    const urls: string[] = [];
    const tool = createLuzTool({ fetchFn: fake(urls, { '2026-11-01': ok(NOV1) }), now: at930 });
    const out = textOf(await tool.execute('t', {}));
    expect(out).toContain('Luz (PVPC) hoy, domingo, 1 de noviembre');
    expect(out).toContain('Ahora (9–10 h): 0,084 €/kWh');
    expect(out).toContain('La más barata: 10–11 h (-0,008 €/kWh)');
    expect(out).toContain('la más cara: 20–21 h (0,298 €/kWh)');
    expect(out).toContain('Horas más baratas: de 10 a 16 h');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').host).toBe('apidatos.ree.es');
    expect(urls[0]).toContain('start_date=2026-11-01T00:00');
  });

  it('la lavadora (2 h seguidas): el mejor tramo de lo que queda de hoy', async () => {
    const tool = createLuzTool({ fetchFn: fake([], { '2026-11-01': ok(NOV1) }), now: at930 });
    const out = textOf(await tool.execute('t', { horas: 2 }));
    expect(out).toContain('Para 2 horas seguidas (lo que queda de hoy): de 10 a 12 h');
    // A las 21:55 lo que queda es 22–24.
    const late = createLuzTool({
      fetchFn: fake([], { '2026-11-01': ok(NOV1) }),
      now: () => new Date('2026-11-01T20:55:00Z'),
    });
    expect(textOf(await late.execute('t', { horas: 2 }))).toContain('de 22 a 0 h');
    // A las 22:30 ya no caben 2 h enteras hoy (la de las 22 ya va por la mitad).
    const veryLate = createLuzTool({
      fetchFn: fake([], { '2026-11-01': ok(NOV1) }),
      now: () => new Date('2026-11-01T21:30:00Z'),
    });
    // Ya son más de las 20:30: los de mañana ya se pueden mirar, sin «a partir de las 20:30».
    const vl = textOf(await veryLate.execute('t', { horas: 2 }));
    expect(vl).toContain('hoy ya no quedan tantas horas seguidas; pregúntame por las de mañana.');
    expect(vl).not.toContain('a partir de las 20:30');
  });

  it('a las 10:50 no propone «de 10 a 12»: la hora en curso ya no da para el tramo entero', async () => {
    const at = (iso: string) =>
      createLuzTool({ fetchFn: fake([], { '2026-11-01': ok(NOV1) }), now: () => new Date(iso) });
    const out = textOf(await at('2026-11-01T09:50:00Z').execute('t', { horas: 2 }));
    expect(out).toContain('Para 2 horas seguidas (lo que queda de hoy): de 11 a 13 h');
    // En los primeros minutos de la hora todavía cuenta.
    const early = textOf(await at('2026-11-01T09:05:00Z').execute('t', { horas: 2 }));
    expect(early).toContain('Para 2 horas seguidas (lo que queda de hoy): de 10 a 12 h');
  });

  it('mañana sin publicar (502 de Red Eléctrica): lo dice en llano, sin el error crudo', async () => {
    const tool = createLuzTool({ fetchFn: fake([], { '2026-11-01': ok(NOV1) }), now: at930 });
    const out = textOf(await tool.execute('t', { dia: 'mañana' }));
    expect(out).toContain('aún no ha publicado los precios de mañana');
    expect(out).not.toMatch(/502|HTTP/);
  });

  it('mañana publicado: pide el día siguiente en hora de Madrid', async () => {
    const urls: string[] = [];
    const nov2 = NOV1.map(
      ([d, v]) => [d.replace('2026-11-01', '2026-11-02'), v] as [string, number],
    );
    const tool = createLuzTool({
      fetchFn: fake(urls, { '2026-11-02': ok(nov2) }),
      // 23:30 del 31-oct en UTC ya es 1-nov en Madrid: «mañana» es el 2.
      now: () => new Date('2026-10-31T23:30:00Z'),
    });
    const out = textOf(await tool.execute('t', { dia: 'mañana', horas: 3 }));
    expect(urls[0]).toContain('start_date=2026-11-02T00:00');
    expect(out).toContain('Luz (PVPC) mañana, lunes, 2 de noviembre');
    expect(out).not.toContain('Ahora');
    expect(out).toContain('Para 3 horas seguidas: de 10 a 13 h');
  });

  it('el día del cambio de hora (25 horas) etiqueta bien las horas', async () => {
    const rows: Array<[string, number]> = [];
    // 25-oct-2026: 00:00–02:00 en CEST (+02:00), luego se repite las 2 en CET (+01:00).
    for (let i = 0; i < 25; i++) {
      const utc = new Date(Date.UTC(2026, 9, 24, 22) + i * 3_600_000);
      rows.push([utc.toISOString(), i === 13 ? 5 : 100]);
    }
    const tool = createLuzTool({
      fetchFn: fake([], { '2026-10-25': ok(rows) }),
      now: () => new Date('2026-10-25T06:00:00Z'),
    });
    const out = textOf(await tool.execute('t', {}));
    // i=13 → 11:00 UTC → 12:00 en Madrid (CET).
    expect(out).toContain('La más barata: 12–13 h (0,005 €/kWh)');
  });

  it('servicio caído o sin red: mensaje amable, sin «fetch failed»', async () => {
    const off = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const out = textOf(await createLuzTool({ fetchFn: off, now: at930 }).execute('t', {}));
    expect(out).toContain('No pude consultar el precio de la luz');
    expect(out).not.toContain('fetch failed');
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const out2 = textOf(await createLuzTool({ fetchFn: down, now: at930 }).execute('t', {}));
    expect(out2).toContain('No pude consultar el precio de la luz');
    expect(out2).not.toMatch(/503/);
  });

  it('se corta por tiempo si Red Eléctrica no contesta', async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    const out = textOf(
      await createLuzTool({ fetchFn: hang, now: at930, timeoutMs: 20 }).execute('t', {}),
    );
    expect(out).toContain('No pude consultar el precio de la luz');
  });

  it('guarda en caché un rato: dos preguntas seguidas, una sola llamada', async () => {
    const urls: string[] = [];
    const tool = createLuzTool({ fetchFn: fake(urls, { '2026-11-01': ok(NOV1) }), now: at930 });
    await tool.execute('t', {});
    await tool.execute('t', { horas: 2 });
    expect(urls).toHaveLength(1);
  });

  it('el aviso de cada noche: apagado por defecto, se enciende y se apaga con palabras', async () => {
    const routines = new Map<string, { schedule: string | null; prompt: string | null }>();
    const store = {
      saveRoutine: (r: {
        scope: string;
        name: string;
        schedule?: string | null;
        prompt?: string | null;
      }) => {
        routines.set(`${r.scope}|${r.name}`, {
          schedule: r.schedule ?? null,
          prompt: r.prompt ?? null,
        });
        return r as never;
      },
      deleteRoutine: (scope: string, name: string) => routines.delete(`${scope}|${name}`),
      getRoutine: (scope: string, name: string) =>
        (routines.has(`${scope}|${name}`) ? { scope, name } : null) as never,
    };
    let synced = 0;
    const urls: string[] = [];
    const tool = createLuzTool({
      fetchFn: fake(urls, {}),
      now: at930,
      store: store as never,
      scopeOf: () => 'tg:1',
      sync: () => {
        synced++;
      },
    });
    expect(routines.size).toBe(0);
    const on = textOf(await tool.execute('t', { aviso: 'activar' }));
    expect(on).toContain('cada noche a las 21:00');
    expect(routines.get(`tg:1|${LUZ_AVISO_ROUTINE}`)?.schedule).toBe(LUZ_AVISO_SCHEDULE);
    expect(routines.get(`tg:1|${LUZ_AVISO_ROUTINE}`)?.prompt).toContain('mañana');
    const off = textOf(await tool.execute('t', { aviso: 'desactivar' }));
    expect(off).toContain('ya no te aviso');
    expect(routines.size).toBe(0);
    expect(textOf(await tool.execute('t', { aviso: 'desactivar' }))).toContain('No tenías');
    expect(synced).toBe(2);
    expect(urls).toHaveLength(0);
  });

  it('la puerta: consultar es lectura; el aviso escribe solo en local', () => {
    const gate = new Gate({ approver: () => true });
    expect(gate.classifyEffect({ tool: 'luz', args: {}, actor: 'test' })).toBe('lee');
    expect(
      gate.classifyEffect({ tool: 'luz', args: { dia: 'mañana', horas: 2 }, actor: 'test' }),
    ).toBe('lee');
    expect(gate.classifyEffect({ tool: 'luz', args: { aviso: 'activar' }, actor: 'test' })).toBe(
      'escribe-local',
    );
  });
});
