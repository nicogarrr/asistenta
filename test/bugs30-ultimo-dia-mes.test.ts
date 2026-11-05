import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseCronAdd, parseNatural } from '../src/cron/scheduler.js';
import { validateSchedule } from '../src/routines.js';

// bugs30: «el último día de cada mes a las 20 revisa los gastos» contestaba «No entiendo
// ese horario». croner tiene el día «L» (28, 29, 30 o 31 según el mes).
describe('rutinas el último día de cada mes (bugs30)', () => {
  it('«el último día de cada mes», «cada fin de mes», «a final de mes»', () => {
    expect(parseNatural('el último día de cada mes a las 20 revisa los gastos')?.schedule).toBe(
      '0 20 L * *',
    );
    expect(parseNatural('el último día del mes a las 20:30 paga la tarjeta')?.schedule).toBe(
      '30 20 L * *',
    );
    expect(parseNatural('cada fin de mes a las 9 manda el informe')?.schedule).toBe('0 9 L * *');
    expect(parseNatural('a final de mes a las 9 revisa el banco')?.schedule).toBe('0 9 L * *');
  });
  it('/cron add la acepta y la dice en palabras', () => {
    const r = parseCronAdd(
      'el último día de cada mes a las 20 revisa los gastos',
      validateSchedule,
    );
    expect(r).toMatchObject({ ok: true, schedule: '0 20 L * *' });
    expect(scheduleEs('0 20 L * *')).toBe('cada mes el último día a las 20:00');
  });
  it('lo que no dice el día se sigue preguntando', () => {
    expect(parseNatural('a finales de mes a las 9 revisa')).toBeNull();
    expect(parseNatural('el último día laborable del mes a las 9 nómina')).toBeNull();
    expect(parseNatural('cada día a las 9 hasta fin de mes')).toBeNull();
    // El último viernes sigue siendo el último viernes.
    expect(parseNatural('el último viernes de cada mes a las 9 informe')?.schedule).toBe(
      '0 9 * * 5#L',
    );
  });
});
