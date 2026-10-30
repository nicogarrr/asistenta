import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateDueAt } from '../src/alerts/due.js';
import { briefingDue } from '../src/briefing.js';
import { followupsDue, greetingFor } from '../src/briefing-daily.js';

// Proceso en UTC y PA_TIMEZONE=Europe/Madrid: las 23:30 UTC del viernes 30/10 ya son
// las 00:30 del sábado 31 para Nico. Vencimientos, saludo y briefing van en su zona.
describe('vencimientos y briefing en PA_TIMEZONE', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
  });
  afterEach(() => {
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });
  const satMidnight = Date.parse('2026-10-30T23:30:00Z'); // sáb 31/10 00:30 en Madrid

  it('«vence el viernes» dicho el sábado 00:30 es el viernes siguiente, no hace una hora', () => {
    expect(new Date(estimateDueAt('vence el viernes', satMidnight)).toISOString()).toBe(
      '2026-11-05T23:30:00.000Z',
    );
  });
  it('«el 31/10» dicho el sábado 31 a las 00:30 es hoy, no mañana', () => {
    expect(new Date(estimateDueAt('lo entrego el 31/10', satMidnight)).toISOString()).toBe(
      '2026-10-30T23:30:00.000Z',
    );
  });
  it('«mañana» cruzando el cambio de hora mantiene la hora de pared', () => {
    // sáb 24/10 10:00 CEST → dom 25/10 10:00 CET
    expect(
      new Date(estimateDueAt('mañana', Date.parse('2026-10-24T08:00:00Z'))).toISOString(),
    ).toBe('2026-10-25T09:00:00.000Z');
  });
  it('el briefing de las 8 sale a las 08:30 de Madrid aunque en UTC sean las 07:30', () => {
    expect(
      briefingDue(Date.parse('2026-10-30T07:05:00Z'), new Date('2026-10-31T07:30:00Z'), 8),
    ).toBe(true);
    expect(
      briefingDue(Date.parse('2026-10-31T07:05:00Z'), new Date('2026-10-31T07:30:00Z'), 8),
    ).toBe(false);
  });
  it('saluda con la hora de Nico', () => {
    expect(greetingFor(new Date('2026-10-30T13:30:00Z'))).toBe('Buenas tardes');
  });
  it('un seguimiento que vence hoy sábado a las 13:00 entra en el briefing de las 00:30', () => {
    const items = [
      { subject: 'factura', dueAt: Date.parse('2026-10-31T12:00:00Z'), status: 'pending' },
    ];
    expect(followupsDue(items, new Date(satMidnight))?.length).toBe(1);
  });
});
