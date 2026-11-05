import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';
import { cadenciaDe } from '../src/cron/cadencia.js';
import { parseNatural } from '../src/cron/scheduler.js';
import { cadenceFromWords, scheduleFromWords, whenFromWords } from '../src/tools/reminder.js';

const tz = 'Europe/Madrid';
const now = new Date('2026-11-05T13:00:00Z'); // jueves 5 nov, 14:00 en Madrid
const local = (d: Date | undefined | null): string =>
  d ? d.toLocaleString('es-ES', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : 'null';

describe('/calendario: «el próximo 15» y la parte del día sin hora', () => {
  it('«el próximo 15 a las 10 ITV» es el 15 a las 10', () => {
    for (const t of [
      'el próximo 15 a las 10 ITV',
      'ITV el próximo 15 a las 10',
      'el próximo día 15 a las 10 ITV',
    ]) {
      const got = parseFechaCalendario(t, now, tz);
      expect(local(got?.start), t).toBe('15/11/26, 10:00');
      expect(got?.title).toBe('ITV');
    }
  });

  it('«mañana por la mañana gimnasio» se apunta a las 9:00 (tarde 17:00, noche 21:00)', () => {
    const cases: Array<[string, string, string]> = [
      ['mañana por la mañana gimnasio', '6/11/26, 9:00', 'gimnasio'],
      ['gimnasio mañana por la mañana', '6/11/26, 9:00', 'gimnasio'],
      ['el viernes por la tarde pádel', '6/11/26, 17:00', 'pádel'],
      ['esta tarde compra', '5/11/26, 17:00', 'compra'],
      ['hoy por la noche cena', '5/11/26, 21:00', 'cena'],
    ];
    for (const [t, when, title] of cases) {
      const got = parseFechaCalendario(t, now, tz);
      expect(local(got?.start), t).toBe(when);
      expect(got?.title).toBe(title);
    }
  });

  it('si dice la hora, manda la hora', () => {
    expect(
      local(parseFechaCalendario('mañana por la mañana a las 10 gimnasio', now, tz)?.start),
    ).toBe('6/11/26, 10:00');
  });

  it('los recordatorios siguen con su propia franja (no las 9:00 fijas)', () => {
    expect(whenFromWords('mañana por la mañana', now, tz)).toBeNull();
  });
});

describe('«cada dos lunes»: cada dos semanas ese día, no todos los días', () => {
  it('parseNatural ya no lo deja en diario', () => {
    expect(parseNatural('cada dos lunes a las 9 basura')).toBeNull();
    expect(scheduleFromWords('cada dos lunes a las 9')).toBeNull();
  });

  it('se programa con cadencia de 2 semanas en ese día', () => {
    for (const [t, cron] of [
      ['cada dos lunes a las 9', '0 9 * * 1'],
      ['cada 2 lunes a las 9', '0 9 * * 1'],
      ['los viernes alternos a las 20', '0 20 * * 5'],
      ['un lunes sí y otro no a las 9', '0 9 * * 1'],
      ['cada dos sábados a las 10', '0 10 * * 6'],
    ] as const) {
      expect(cadenceFromWords(t), t).toEqual({
        schedule: cron,
        cadencia: { n: 2, unidad: 'semana' },
      });
    }
    expect(cadenciaDe('cada tres martes')).toEqual({ n: 3, unidad: 'semana' });
  });

  it('«los días laborables menos el viernes» son de lunes a jueves', () => {
    expect(scheduleFromWords('los días laborables menos el viernes a las 8')).toBe(
      '0 8 * * 1,2,3,4',
    );
  });
});
