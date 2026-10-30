import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../src/goals/store.js';
import { formatProposal, nextTicksEs } from '../src/tools/goal.js';

// La propuesta de un objetivo dice cuándo serán los próximos ticks, en español y
// en la hora de pared de PA_TIMEZONE, no solo el cron en crudo.
const saved = { TZ: process.env.TZ, PA: process.env.PA_TIMEZONE };

beforeEach(() => {
  process.env.TZ = 'UTC';
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T10:00:00Z')); // jueves 11:00 en Madrid
});
afterEach(() => {
  vi.useRealTimers();
  if (saved.TZ === undefined) delete process.env.TZ;
  else process.env.TZ = saved.TZ;
  if (saved.PA === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = saved.PA;
});

function goal(cadence: string): Goal {
  return {
    id: 'g1',
    title: 'Vigilar precios',
    verbatim: 'vigila el precio de la tele',
    plan: [{ text: 'mirar la web' }],
    cadence,
  } as unknown as Goal;
}

describe('próximos ticks en la propuesta de objetivo', () => {
  it('nextTicksEs da fechas en español y hora de Madrid', () => {
    expect(nextTicksEs('0 9 * * 1')).toBe('lun 09/11 09:00, lun 16/11 09:00, lun 23/11 09:00');
    expect(nextTicksEs('30 8 * * *', 2)).toBe('vie 06/11 08:30, sáb 07/11 08:30');
  });

  it('una cadencia inválida o sin futuro no da nada', () => {
    expect(nextTicksEs('no es cron')).toBe('');
    expect(nextTicksEs('0 0 30 2 *')).toBe('');
  });

  it('formatProposal añade la línea de próximos ticks', () => {
    const text = formatProposal(goal('0 9 * * 1-5'));
    expect(text).toContain('Próximos ticks: vie 06/11 09:00, lun 09/11 09:00, mar 10/11 09:00.');
    expect(text).toContain('Cadencia de trabajo: cada tick según "0 9 * * 1-5"');
  });
});
