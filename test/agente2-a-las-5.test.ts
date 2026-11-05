import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool, whenFromWords } from '../src/tools/reminder.js';

/**
 * agente-2: «recuérdame a las 5 llamar a mamá» dicho a las 10 de la mañana se programaba
 * para las 5:00 de la madrugada siguiente, y como «sus palabras mandan» (#2001) se pisaba
 * la hora buena del modelo (17:00) con «Lo he puesto a la hora que dijiste». En España «a
 * las 5» sin más, de día, son las cinco de la tarde. Ahora una hora de 1 a 11 sin «de la
 * mañana/tarde/noche» se lee como la próxima de las dos (5:00 o 17:00), y si el modelo eligió
 * una de las dos lecturas, se respeta.
 */
describe('recordatorio: «a las 5» sin más es la próxima 5', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  // Jueves 5 de noviembre de 2026, 10:00 en Madrid.
  const NOW = new Date('2026-11-05T09:00:00Z');
  // Mismo día, 20:00 en Madrid.
  const NIGHT = new Date('2026-11-05T19:00:00Z');
  let dir: string;
  let store: Store;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    dir = mkdtempSync(join(tmpdir(), 'ag2rem-'));
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

  it('sin día: la próxima de las dos lecturas', () => {
    expect(madrid(whenFromWords('a las 5', NOW))).toBe('2026-11-05 17:00');
    expect(madrid(whenFromWords('a las cinco', NOW))).toBe('2026-11-05 17:00');
    expect(madrid(whenFromWords('a las 7 menos cuarto', NOW))).toBe('2026-11-05 18:45');
    expect(madrid(whenFromWords('a las 3 y media', NOW))).toBe('2026-11-05 15:30');
    expect(madrid(whenFromWords('a las 7', NOW))).toBe('2026-11-05 19:00');
    // Aún no ha pasado por la mañana: la de la mañana.
    expect(madrid(whenFromWords('a las 11', NOW))).toBe('2026-11-05 11:00');
    // A las 20:00, «a las 9» son las 21:00 y «a las 8» mañana por la mañana.
    expect(madrid(whenFromWords('a las 9', NIGHT))).toBe('2026-11-05 21:00');
    expect(madrid(whenFromWords('a las 11', NIGHT))).toBe('2026-11-05 23:00');
    expect(madrid(whenFromWords('a las 8', NIGHT))).toBe('2026-11-06 08:00');
  });

  it('«hoy a las 5» de día no es una hora que ya pasó', () => {
    expect(madrid(whenFromWords('hoy a las 5', NOW))).toBe('2026-11-05 17:00');
  });

  it('con «de la mañana», «de la tarde», 24 h o un cero delante no se toca', () => {
    expect(madrid(whenFromWords('a las 5 de la mañana', NOW))).toBe('2026-11-06 05:00');
    expect(madrid(whenFromWords('mañana a las 5 de la mañana', NOW))).toBe('2026-11-06 05:00');
    expect(madrid(whenFromWords('a las 5 de la tarde', NOW))).toBe('2026-11-05 17:00');
    expect(madrid(whenFromWords('a las 05:00', NOW))).toBe('2026-11-06 05:00');
    expect(madrid(whenFromWords('a las 18:00', NOW))).toBe('2026-11-05 18:00');
    expect(madrid(whenFromWords('mañana a las 9,30', NOW))).toBe('2026-11-06 09:30');
  });

  it('otro día, de 1 a 6 sin más es por la tarde («mañana a las 5» = 17:00)', () => {
    expect(madrid(whenFromWords('mañana a las 5', NOW))).toBe('2026-11-06 17:00');
    expect(madrid(whenFromWords('el lunes a las 4 y media', NOW))).toBe('2026-11-09 16:30');
    // De 7 a 11 queda por la mañana.
    expect(madrid(whenFromWords('mañana a las 8', NOW))).toBe('2026-11-06 08:00');
  });

  const tool = (now: Date) =>
    createReminderTool({
      store,
      scopeOf: () => 'tg:1:2',
      sync: () => {},
      now: () => now.getTime(),
    });
  const run = async (args: Record<string, unknown>, now = NOW): Promise<string> => {
    const res = await tool(now).execute('id', args as never);
    const first = res.content[0];
    return first && first.type === 'text' ? first.text : '';
  };

  it('la hora buena del modelo (17:00) ya no se cambia por las 5 de la madrugada', async () => {
    const out = await run({
      action: 'create',
      text: 'llamar a mamá',
      at: '2026-11-05T17:00',
      said: 'a las 5',
    });
    expect(out).toContain('2026-11-05 17:00');
    expect(out).not.toContain('hora que dijiste');
    expect(store.listRoutines('tg:1:2')[0]?.schedule).toBe('0 17 5 11 *');
  });

  it('si el modelo eligió la otra lectura a propósito («mañana a las 5» = 5:00), se respeta', async () => {
    const out = await run({
      action: 'create',
      text: 'salir al aeropuerto',
      at: '2026-11-06T05:00',
      said: 'mañana a las 5',
    });
    expect(out).toContain('2026-11-06 05:00');
    expect(out).not.toContain('hora que dijiste');
  });

  it('si el modelo se equivoca de día, sus palabras siguen mandando', async () => {
    const out = await run({
      action: 'create',
      text: 'llamar a mamá',
      at: '2026-11-06T17:00',
      said: 'a las 5',
    });
    expect(out).toContain('2026-11-05 17:00');
    expect(out).toContain('hora que dijiste');
  });
});
