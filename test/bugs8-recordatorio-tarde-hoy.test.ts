import { describe, expect, it, vi } from 'vitest';
import type { Routine, Store } from '../src/db.js';
import { deliverMissedReminders, lateReminderText } from '../src/tools/reminder.js';

// Un recordatorio que llega tarde el mismo día decía «era para el 01/11 a las 09:00»
// cuando el 01/11 es hoy. Ahora dice «hoy» (o «ayer»), como el resto de avisos.
const NOW = new Date('2026-11-01T08:30:00Z').getTime(); // domingo 1 nov, 09:30 en Madrid
const r = (stamp: string) => ({
  name: `recordatorio-1: comprar pan @${stamp}`,
  prompt: 'comprar pan',
});

describe('recordatorio con retraso: «hoy» y «ayer»', () => {
  it('del mismo día dice «hoy»', () => {
    expect(lateReminderText(r('2026-11-01 09:00'), NOW)).toBe(
      '⏰ Te lo recuerdo con retraso, era para hoy a las 09:00: comprar pan',
    );
  });

  it('del día anterior dice «ayer»', () => {
    expect(lateReminderText(r('2026-10-31 21:00'), NOW)).toBe(
      '⏰ Te lo recuerdo con retraso, era para ayer a las 21:00: comprar pan',
    );
  });

  it('más atrás sigue con la fecha', () => {
    expect(lateReminderText(r('2026-10-30 09:00'), NOW)).toBe(
      '⏰ Te lo recuerdo con retraso, era para el 30/10 a las 09:00: comprar pan',
    );
  });

  it('al arrancar, el aviso tardío usa la misma hora de «ahora»', async () => {
    const routine = {
      id: 'r1',
      scope: 'telegram:dm:42',
      name: 'recordatorio-1: comprar pan @2026-11-01 09:00',
      kind: 'schedule',
      prompt: 'comprar pan',
      enabled: true,
    } as unknown as Routine;
    const store = { listRoutines: () => [routine], deleteRoutine: vi.fn() } as unknown as Store;
    const send = vi.fn(async (_s: string, _t: string, _r: string) => true);
    await deliverMissedReminders({ store, send, now: NOW });
    expect(send.mock.calls[0]?.[1]).toContain('era para hoy a las 09:00');
  });
});
