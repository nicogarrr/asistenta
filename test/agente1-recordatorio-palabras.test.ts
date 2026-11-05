import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool, whenFromWords } from '../src/tools/reminder.js';

/**
 * El modelo pasaba «mañana a las 9,30» o «el viernes a las 8 de la tarde» a una fecha a mano
 * y a veces se equivocaba (un día de más, las 9:00 en vez de las 9:30). Ahora la herramienta
 * recibe también las palabras del dueño (`said`), las lee con el mismo lector que /calendario
 * y, si no cuadran con `at`, mandan las palabras y la respuesta lo dice.
 */
describe('recordatorio: la hora dicha por el dueño manda', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  // Jueves 5 de noviembre de 2026, 10:00 en Madrid.
  const NOW = new Date('2026-11-05T09:00:00Z');
  let dir: string;
  let store: Store;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    dir = mkdtempSync(join(tmpdir(), 'ag1rem-'));
    store = new Store(join(dir, 'db.sqlite'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });

  const madrid = (d: Date | null): string =>
    d ? d.toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16) : 'null';

  it('lee las formas de decir la hora', () => {
    expect(madrid(whenFromWords('mañana a las 9,30', NOW))).toBe('2026-11-06 09:30');
    expect(madrid(whenFromWords('el viernes a las 8 de la tarde', NOW))).toBe('2026-11-06 20:00');
    expect(madrid(whenFromWords('dentro de 2 horas', NOW))).toBe('2026-11-05 12:00');
    expect(madrid(whenFromWords('pasado mañana a las 10 y media', NOW))).toBe('2026-11-07 10:30');
    // Sin día: hoy si aún no ha pasado; si ya pasó, mañana.
    expect(madrid(whenFromWords('a las 18:00', NOW))).toBe('2026-11-05 18:00');
    expect(madrid(whenFromWords('a las 7', NOW))).toBe('2026-11-06 07:00');
    expect(whenFromWords('cuando puedas', NOW)).toBeNull();
    expect(whenFromWords('', NOW)).toBeNull();
  });

  const tool = () =>
    createReminderTool({
      store,
      scopeOf: () => 'tg:1:2',
      sync: () => {},
      now: () => NOW.getTime(),
    });
  const run = async (args: Record<string, unknown>): Promise<string> => {
    const res = await tool().execute('id', args as never);
    const first = res.content[0];
    return first && first.type === 'text' ? first.text : '';
  };

  it('si `at` no cuadra con lo dicho, se programa a la hora dicha y lo avisa', async () => {
    const out = await run({
      action: 'create',
      text: 'llamar al taller',
      at: '2026-11-06T09:00',
      said: 'mañana a las 9,30',
    });
    expect(out).toContain('2026-11-06 09:30');
    expect(out).toContain('a la hora que dijiste');
    expect(store.listRoutines('tg:1:2')[0]?.schedule).toBe('30 9 6 11 *');
  });

  it('si cuadra, no cambia nada ni añade avisos', async () => {
    const out = await run({
      action: 'create',
      text: 'pagar el alquiler',
      at: '2026-11-06T20:00',
      said: 'el viernes a las 8 de la tarde',
    });
    expect(out).toBe(
      'Recordatorio programado para 2026-11-06 20:00 (hora local): pagar el alquiler.',
    );
  });

  it('solo con `said` también vale; si no se entiende, vale `at`', async () => {
    expect(await run({ action: 'create', text: 'horno', said: 'dentro de 2 horas' })).toContain(
      '2026-11-05 12:00',
    );
    expect(
      await run({ action: 'create', text: 'médico', at: '2026-11-09T11:00', said: 'el lunes' }),
    ).toBe('Recordatorio programado para 2026-11-09 11:00 (hora local): médico.');
    expect(await run({ action: 'create', text: 'x', said: 'algún día' })).toContain(
      'exactamente uno de',
    );
  });
});
