import { describe, expect, it, vi } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { reminderButtons } from '../src/cli.js';
import { deliverMissedThenStart } from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';
import { deliverMissedReminders, FiredReminders, onceCron } from '../src/tools/reminder.js';

/**
 * Los recordatorios que llegan tarde (el PC estaba apagado a su hora) salen con los
 * mismos «✅ Hecho» / «⏰ +1h» que los que llegan a tiempo. Ninguno borra nada.
 */
const pad = (n: number) => String(n).padStart(2, '0');
function missed(text: string, scope = 'telegram:dm:42'): Routine {
  const due = new Date(Date.now() - 2 * 3600_000);
  due.setSeconds(0, 0);
  const stamp = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())} ${pad(due.getHours())}:${pad(due.getMinutes())}`;
  return {
    id: 'r1',
    scope,
    name: `recordatorio-1: ${text} @${stamp}`,
    kind: 'schedule',
    params: null,
    steps: null,
    prompt: text,
    schedule: onceCron(due),
    enabled: true,
  } as unknown as Routine;
}
const storeWith = (list: Routine[]) =>
  ({ listRoutines: () => list, deleteRoutine: vi.fn() }) as unknown as Store;

describe('recordatorio con retraso: botones', () => {
  it('deliverMissedReminders pasa el texto del recordatorio al envío', async () => {
    const send = vi.fn(async (_scope: string, _text: string, _reminder?: string) => true);
    await deliverMissedReminders({ store: storeWith([missed('pagar la luz')]), send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]).toBe('pagar la luz');
  });

  it('deliverMissedThenStart manda el aviso tardío con «✅ Hecho» y «⏰ +1h»', async () => {
    const fired = new FiredReminders();
    const send = vi.fn(async () => undefined);
    await deliverMissedThenStart({
      store: storeWith([missed('pagar la luz')]),
      send,
      start: () => {},
      reminderButtons: (scope, text) => reminderButtons(fired.remember(scope, text)),
    });
    const call = send.mock.calls[0] as unknown as [
      string,
      string,
      Array<{ label: string; action: string }>,
    ];
    expect(call[0]).toBe('42');
    expect(call[1]).toContain('con retraso');
    expect(call[2]?.map((b) => b.label)).toEqual(['✅ Hecho', '⏰ +1h']);
    const cmds = call[2]?.map((b) => commandFromCallback(b.action)) ?? [];
    expect(cmds[0]).toMatch(/^\/recordatorios hecho [0-9a-f]{8}$/);
    expect(cmds[1]).toMatch(/^\/recordatorios pospone [0-9a-f]{8}$/);
  });

  it('sin reminderButtons sigue mandándose sin botones (2 argumentos)', async () => {
    const send = vi.fn(async () => undefined);
    await deliverMissedThenStart({ store: storeWith([missed('x')]), send, start: () => {} });
    expect(send.mock.calls[0]).toHaveLength(2);
  });
});
