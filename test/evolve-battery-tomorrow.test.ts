import { describe, expect, it } from 'vitest';
import { type BatteryCase, judge, type Trace } from '../src/evolve/battery-judge.js';

// «recuérdame mañana a las 9»: el juez de la batería calculaba «mañana» como ahora + 24 h.
// El día del cambio de hora no tiene 24 h: el 25-oct-2026 (25 h) a las 00:30 «mañana» salía
// el mismo domingo, y el 28-mar-2026 a las 23:30 (el domingo tiene 23 h) salía el lunes. Un
// recordatorio bien puesto contaba como fallo.

const c: BatteryCase = {
  id: 'B-t9',
  prompt: 'recuérdame mañana a las 9',
  machine: { timeCheck: 'tomorrow9' },
};
const trace = (fireAtIso: string): Trace => ({
  reply: 'Hecho: mañana a las 09:00 te lo recuerdo.',
  toolCalls: [{ name: 'reminder.create', ok: true }],
  approvalsAsked: 0,
  scheduled: [{ kind: 'once', fireAtIso }],
});

describe('batería: «mañana a las 9» con cambio de hora', () => {
  it('la madrugada del cambio de otoño, mañana es el lunes', () => {
    const now = new Date('2026-10-24T22:30:00Z'); // domingo 25, 00:30 en Madrid (aún CEST)
    expect(judge(c, trace('2026-10-26T08:00:00Z'), now).verdict).toBe('pass'); // lunes 09:00 CET
    expect(judge(c, trace('2026-10-25T08:00:00Z'), now).verdict).toBe('fail'); // el mismo domingo
  });
  it('la noche antes del cambio de primavera, mañana es el domingo', () => {
    const now = new Date('2026-03-28T22:30:00Z'); // sábado 28, 23:30 en Madrid (CET)
    expect(judge(c, trace('2026-03-29T07:00:00Z'), now).verdict).toBe('pass'); // domingo 09:00 CEST
    expect(judge(c, trace('2026-03-30T07:00:00Z'), now).verdict).toBe('fail'); // pasado mañana
  });
  it('un día normal sigue igual', () => {
    const now = new Date('2026-11-04T17:00:00Z'); // miércoles 18:00 en Madrid
    expect(judge(c, trace('2026-11-05T08:00:00Z'), now).verdict).toBe('pass');
    expect(judge(c, trace('2026-11-05T09:00:00Z'), now).verdict).toBe('fail'); // a las 10
  });
});
