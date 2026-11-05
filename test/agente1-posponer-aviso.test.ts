import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import {
  FiredReminders,
  SNOOZE_WINDOW_MS,
  snoozeReminder,
  snoozeWhen,
} from '../src/tools/reminder.js';

/**
 * Cuando sonaba un aviso, posponerlo solo se podía con el botón «⏰ +1h» o «🌅 Mañana». Un
 * «recuérdamelo en 10 minutos» o «dentro de media hora» iba al modelo, que a veces creaba
 * otro recordatorio con otro texto, o ninguno. Ahora, justo después de un aviso, posponerlo
 * hablando reprograma ese mismo aviso al momento.
 */
describe('posponer un aviso hablando', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  // Jueves 5 de noviembre de 2026, 10:00 en Madrid.
  const NOW = new Date('2026-11-05T09:00:00Z');
  let dir: string;
  let store: Store;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    dir = mkdtempSync(join(tmpdir(), 'ag1snz-'));
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

  it('entiende las formas de posponer', () => {
    expect(madrid(snoozeWhen('en 10 minutos', NOW))).toBe('2026-11-05 10:10');
    expect(madrid(snoozeWhen('Recuérdamelo en media hora', NOW))).toBe('2026-11-05 10:30');
    expect(madrid(snoozeWhen('pospónlo 20 min', NOW))).toBe('2026-11-05 10:20');
    expect(madrid(snoozeWhen('10 minutos más', NOW))).toBe('2026-11-05 10:10');
    expect(madrid(snoozeWhen('+15 min', NOW))).toBe('2026-11-05 10:15');
    expect(madrid(snoozeWhen('vale, dentro de 2 horas', NOW))).toBe('2026-11-05 12:00');
    expect(madrid(snoozeWhen('avísame otra vez en una hora', NOW))).toBe('2026-11-05 11:00');
    expect(madrid(snoozeWhen('mañana', NOW))).toBe('2026-11-06 09:00');
    expect(madrid(snoozeWhen('recuérdamelo mañana a las 8', NOW))).toBe('2026-11-06 08:00');
  });

  it('lo demás no es posponer (lo lleva el modelo)', () => {
    expect(snoozeWhen('gracias', NOW)).toBeNull();
    expect(snoozeWhen('ya lo he hecho', NOW)).toBeNull();
    expect(snoozeWhen('en 10 minutos llamo a Ana y luego te cuento', NOW)).toBeNull();
    expect(snoozeWhen('1 min', NOW)).toBeNull();
    expect(snoozeWhen('recuérdamelo', NOW)).toBeNull();
  });

  it('solo vale justo después del aviso, en su chat y una vez', () => {
    let clock = 1_000;
    const fired = new FiredReminders(() => clock);
    fired.remember('tg:42:0', 'tomar la pastilla');
    const in42 = (s: string): boolean => s.startsWith('tg:42:');
    clock = 2_000;
    expect(fired.justFired(in42)).toEqual({ scope: 'tg:42:0', text: 'tomar la pastilla' });
    expect(fired.justFired((s) => s.startsWith('tg:7:'))).toBeNull();
    clock = 1_000 + SNOOZE_WINDOW_MS + 1;
    expect(fired.justFired(in42)).toBeNull();
    clock = 2_000;
    expect(fired.justFired(in42, { take: true })).not.toBeNull();
    expect(fired.justFired(in42)).toBeNull();
  });

  it('reprograma el mismo aviso y lo dice como el botón', () => {
    const fired = { scope: 'tg:42:0', text: 'tomar la pastilla' };
    const out = snoozeReminder(store, fired, snoozeWhen('en 10 minutos', NOW) as Date, NOW);
    expect(out).toBe('⏰ Te lo vuelvo a recordar a las 10:10: tomar la pastilla');
    const [r] = store.listRoutines('tg:42:0');
    expect(r?.prompt).toBe('tomar la pastilla');
    expect(r?.schedule).toBe('10 10 5 11 *');
    const tomorrow = snoozeReminder(store, fired, snoozeWhen('mañana', NOW) as Date, NOW);
    expect(tomorrow).toBe('⏰ Te lo vuelvo a recordar el 06/11 a las 09:00: tomar la pastilla');
  });
});
