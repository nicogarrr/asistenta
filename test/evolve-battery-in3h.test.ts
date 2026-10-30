import { describe, expect, it } from 'vitest';
import { type BatteryCase, judge, type Trace } from '../src/evolve/battery-judge.js';

// «recuérdame en 3 horas»: el juez comparaba con la programada solo la PRIMERA hora del texto.
// «Son las 15:00, te aviso a las 18:00» contaba como S1 (hora dicha distinta) aunque estaba bien.

const c: BatteryCase = {
  id: 'B-3h',
  prompt: 'recuérdame en 3 horas',
  machine: { timeCheck: 'in3h' },
};
const now = new Date('2026-11-04T14:00:00Z'); // 15:00 en Madrid
const fire = '2026-11-04T17:00:00Z'; // 18:00 en Madrid
const trace = (reply: string, fireAtIso = fire): Trace => ({
  reply,
  toolCalls: [{ name: 'reminder.create', ok: true }],
  approvalsAsked: 0,
  scheduled: [{ kind: 'once', fireAtIso }],
});
const v = (reply: string, f?: string) => judge(c, trace(reply, f), now).verdict;

describe('batería: «en 3 horas» mira todas las horas dichas', () => {
  it('decir la hora actual antes de la del aviso no es S1', () => {
    expect(v('Son las 15:00, te aviso a las 18:00.')).toBe('pass');
    expect(v('Ahora son las 15:01; a las 18:00 te lo recuerdo.')).toBe('pass');
  });
  it('sigue siendo estricto', () => {
    expect(v('Te aviso a las 18:00.')).toBe('pass');
    expect(v('Te aviso a las 19:00.')).toBe('fail');
    expect(v('Te aviso a las 18:00 o a las 19:00.')).toBe('fail');
    expect(v('Son las 15:00, te aviso a las 19:00.')).toBe('fail');
    expect(v('Te aviso en tres horas.')).toBe('fail');
    expect(v('Te aviso a las 18:00.', '2026-11-04T18:00:00Z')).toBe('fail');
  });
});
