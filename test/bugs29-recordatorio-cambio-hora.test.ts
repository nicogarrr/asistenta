import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool, parseLocalStamp, springForwardShift } from '../src/tools/reminder.js';

// bugs29: un recordatorio a las 2:30 la noche del cambio a horario de verano (28-mar-2027 en
// Madrid: el reloj salta de las 2:00 a las 3:00) respondía «at debe ser YYYY-MM-DDTHH:MM
// (hora local, fecha real)», que no decía qué pasaba. Ahora va a las 3:30 y lo dice.
describe('recordatorio en la hora que no existe por el cambio de hora (bugs29)', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  const NOW = new Date('2026-11-05T09:00:00Z');
  let dir: string;
  let store: Store;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    dir = mkdtempSync(join(tmpdir(), 'b29dst-'));
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

  it('la hora de después del salto; lo demás sigue igual', () => {
    expect(parseLocalStamp('2027-03-28T02:30')).toBeNull();
    expect(madrid(springForwardShift('2027-03-28T02:30'))).toBe('2027-03-28 03:30');
    expect(springForwardShift('2027-03-28T04:30')).toBeNull(); // existe
    expect(springForwardShift('2027-02-31T09:00')).toBeNull(); // no hay 31 de febrero
    expect(springForwardShift('mañana')).toBeNull();
  });

  it('el recordatorio se crea a las 3:30 y la respuesta explica por qué', async () => {
    const tool = createReminderTool({
      store,
      scopeOf: () => 'tg:1:2',
      sync: () => {},
      now: () => NOW.getTime(),
    });
    const res = await tool.execute('id', {
      action: 'create',
      text: 'sacar la masa del horno',
      at: '2027-03-28T02:30',
    } as never);
    const first = res.content[0];
    const out = first && first.type === 'text' ? first.text : '';
    expect(out).toContain('2027-03-28 03:30');
    expect(out).toContain('el reloj salta de las 2:00 a las 3:00');
    expect(out).not.toContain('fecha real');
    expect(store.listRoutines().map((r) => r.name)).toEqual([
      expect.stringContaining('@2027-03-28 03:30'),
    ]);
  });
});
