import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { reminderButtons } from '../src/cli.js';
import type { Routine } from '../src/db.js';
import {
  FIRED_BUTTON_STALE,
  FiredReminders,
  nextMorningAt9,
  reminderButtonCommand,
} from '../src/tools/reminder.js';

/** «🌅 Mañana 9:00» al lado de «⏰ +1h»: otro recordatorio puntual igual, mañana a las 9 (hora de PA_TIMEZONE). No borra nada. */
const SCOPE = 'telegram:dm:42#main';
const sameChat = (s: string) => s === SCOPE;
function fakeStore() {
  const routines: Routine[] = [];
  return {
    routines,
    listRoutines: (scope?: string) => routines.filter((r) => !scope || r.scope === scope),
    saveRoutine: (r: Partial<Routine> & { scope: string; name: string }) => {
      routines.push(r as Routine);
    },
  };
}
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PA_TIMEZONE;
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterEach(() => {
  if (saved === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = saved;
});

describe('botón «🌅 Mañana 9:00» de un recordatorio', () => {
  it('va tercero y se lee como /recordatorios manana <id>', () => {
    const b = reminderButtons('a1b2c3d4');
    expect(b?.map((x) => x.label)).toEqual(['✅ Hecho', '⏰ +1h', '🌅 Mañana 9:00']);
    expect(commandFromCallback(b?.[2]?.action ?? '')).toBe('/recordatorios manana a1b2c3d4');
  });

  it('nextMorningAt9: mañana a las 9 en Madrid, también el día del cambio de hora', () => {
    expect(new Date(nextMorningAt9(Date.parse('2026-10-30T18:00:00Z'))).toISOString()).toBe(
      '2026-10-31T08:00:00.000Z',
    );
    // 24/10 20:00 (verano) → 25/10 09:00 ya en horario de invierno (UTC+1).
    expect(new Date(nextMorningAt9(Date.parse('2026-10-24T18:00:00Z'))).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    );
    expect(new Date(nextMorningAt9(Date.parse('2026-06-10T10:00:00Z'))).toISOString()).toBe(
      '2026-06-11T07:00:00.000Z',
    );
  });

  it('de madrugada (antes de las 5) «mañana» es hoy a las 9', () => {
    expect(new Date(nextMorningAt9(Date.parse('2026-10-30T01:30:00Z'))).toISOString()).toBe(
      '2026-10-30T08:00:00.000Z',
    );
  });

  it('crea el recordatorio puntual para mañana a las 9 y lo dice con la fecha', () => {
    const fired = new FiredReminders(() => Date.parse('2026-10-30T18:00:00Z'));
    const store = fakeStore();
    const id = fired.remember(SCOPE, 'sacar la basura');
    const reply = reminderButtonCommand(
      { fired, store: store as never, sameChat, now: () => Date.parse('2026-10-30T18:00:00Z') },
      'manana',
      id,
    );
    expect(reply).toBe('🌅 Te lo vuelvo a recordar mañana (31/10) a las 09:00: sacar la basura');
    expect(store.routines).toHaveLength(1);
    expect(store.routines[0]?.name).toContain('@2026-10-31 09:00');
    expect(store.routines[0]?.prompt).toBe('sacar la basura');
    // Vale una vez.
    expect(
      reminderButtonCommand(
        { fired, store: store as never, sameChat, now: () => Date.parse('2026-10-30T18:00:00Z') },
        'manana',
        id,
      ),
    ).toBe(FIRED_BUTTON_STALE);
  });
});
