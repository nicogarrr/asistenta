import { describe, expect, it, vi } from 'vitest';
import { createGoalNotifySend, type GoalNotifyChannel } from '../src/daemon/goal-notify.js';
import type { Goal } from '../src/goals/store.js';

type Msg = Parameters<GoalNotifyChannel['send']>[0];

function setup(reply: (m: Msg) => Promise<string | null | undefined>) {
  const sent: Msg[] = [];
  const telegram: GoalNotifyChannel = {
    account: 'acct',
    send: (m) => {
      sent.push(m);
      return reply(m);
    },
  };
  const messageThread = new Map<string, string>();
  const warn = vi.fn();
  const send = createGoalNotifySend({ telegram, messageThread, log: { warn } });
  return { sent, messageThread, warn, send };
}
const goal = (scope: string) => ({ id: 'g1', scope }) as Goal;

describe('createGoalNotifySend (avisos de objetivos)', () => {
  it('#main: al chat del objetivo, sin hilo, y apunta el id para la respuesta', async () => {
    const s = setup(async () => '55');
    expect(await s.send(goal('telegram:acct:123#main'), 'hola')).toBe('55');
    expect(s.sent).toEqual([
      {
        channel: 'telegram',
        account: 'acct',
        chatId: '123',
        text: 'hola',
        threadId: undefined,
        replyToMessageId: undefined,
      },
    ]);
    expect(s.messageThread.get('telegram:acct:123:55')).toBe('telegram:acct:123#main');
  });
  it('tema de foro (t42) → threadId; conversación de mensaje (m7) → respuesta al 7', async () => {
    const s = setup(async () => '9');
    await s.send(goal('telegram:acct:123#t42'), 'a');
    await s.send(goal('telegram:acct:123#m7'), 'b');
    expect(s.sent[0]?.threadId).toBe('42');
    expect(s.sent[0]?.replyToMessageId).toBeUndefined();
    expect(s.sent[1]?.replyToMessageId).toBe('7');
    expect(s.sent[1]?.threadId).toBeUndefined();
    expect(s.messageThread.get('telegram:acct:123:9')).toBe('telegram:acct:123#m7');
  });
  it('sin chat en el scope no envía nada', async () => {
    const s = setup(async () => '1');
    expect(await s.send(goal('cli#main'), 'x')).toBeNull();
    expect(s.sent).toEqual([]);
  });
  it('el transporte dice no (null) → null y no se apunta nada', async () => {
    const s = setup(async () => null);
    expect(await s.send(goal('telegram:acct:123#main'), 'x')).toBeNull();
    expect(s.messageThread.size).toBe(0);
  });
  it('un fallo de Telegram no lanza: null y queda en el log', async () => {
    const s = setup(async () => {
      throw new Error('caído');
    });
    expect(await s.send(goal('telegram:acct:123#main'), 'x')).toBeNull();
    expect(s.warn).toHaveBeenCalledWith(
      'goal notify failed',
      expect.objectContaining({ goal: 'g1' }),
    );
  });
});
