import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { reminderButtons } from '../src/cli.js';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import type { Routine } from '../src/db.js';
import {
  FIRED_BUTTON_MS,
  FIRED_BUTTON_STALE,
  FiredReminders,
  isOneShotReminder,
  reminderButtonCommand,
} from '../src/tools/reminder.js';

/**
 * El aviso de un recordatorio trae «✅ Hecho» y «⏰ +1h». Ninguno borra nada: «Hecho» lo
 * da por visto y «+1h» crea otro recordatorio puntual con el mismo texto.
 */
function fakeStore(initial: Routine[] = []) {
  const routines: Routine[] = [...initial];
  return {
    routines,
    listRoutines: (scope?: string) => routines.filter((r) => !scope || r.scope === scope),
    saveRoutine: (r: Partial<Routine> & { scope: string; name: string }) => {
      routines.push(r as Routine);
    },
  };
}
const SCOPE = 'telegram:dm:42#main';
const sameChat = (s: string) => s === SCOPE;

describe('botones del aviso de un recordatorio', () => {
  it('son «✅ Hecho» y «⏰ +1h» y se leen como /recordatorios hecho|pospone <id>', () => {
    const b = reminderButtons('a1b2c3d4');
    expect(b?.map((x) => x.label)).toEqual(['✅ Hecho', '⏰ +1h', '🌅 Mañana 9:00']);
    expect(b?.map((x) => commandFromCallback(x.action))).toEqual([
      '/recordatorios hecho a1b2c3d4',
      '/recordatorios pospone a1b2c3d4',
      '/recordatorios manana a1b2c3d4',
    ]);
    expect(commandFromCallback('cmd:recordatorios borrar a1b2c3d4')).toBeUndefined();
  });

  it('el aviso de un recordatorio sale con sus botones', async () => {
    const send = vi.fn(async () => undefined);
    const fire = createRoutineFire({
      store: fakeStore() as never,
      tickGoal: async () => undefined,
      runTask: async () => 'hecho el trabajo',
      send,
      reminderButtons: (_scope, text) => [{ label: text, action: 'cmd:x' }],
      delivery: {
        get: () => ({ lastHash: null }),
        commit: () => undefined,
      } as never,
      outputDir: '/nonexistent',
      sync: () => undefined,
      droppedRemindersPath: '/nonexistent/x.jsonl',
    });
    const reminder = {
      scope: SCOPE,
      name: 'recordatorio: regar',
      kind: 'schedule',
      prompt: 'regar las plantas',
      schedule: '0 9 * * *',
    } as Routine;
    await fire('', { scope: SCOPE, routine: reminder } as never);
    expect(send).toHaveBeenCalledWith('42', '⏰ Recordatorio: regar las plantas', [
      { label: 'regar las plantas', action: 'cmd:x' },
    ]);
  });

  it('«Hecho» lo da por visto sin borrar nada, y el botón vale una vez', () => {
    const fired = new FiredReminders();
    const store = fakeStore();
    const id = fired.remember(SCOPE, 'regar las plantas');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(reminderButtonCommand({ fired, store: store as never, sameChat }, 'hecho', id)).toBe(
      '✅ Hecho: regar las plantas',
    );
    expect(store.routines).toHaveLength(0);
    expect(reminderButtonCommand({ fired, store: store as never, sameChat }, 'hecho', id)).toBe(
      FIRED_BUTTON_STALE,
    );
  });

  it('«+1h» crea un recordatorio puntual con el mismo texto dentro de una hora', () => {
    const now = Date.UTC(2026, 9, 30, 17, 0);
    const fired = new FiredReminders(() => now);
    const store = fakeStore();
    const id = fired.remember(SCOPE, 'llamar a mamá');
    const reply = reminderButtonCommand(
      { fired, store: store as never, sameChat, now: () => now },
      'pospone',
      id,
    );
    expect(reply.startsWith('⏰ Te lo vuelvo a recordar a las ')).toBe(true);
    expect(reply.endsWith(': llamar a mamá')).toBe(true);
    expect(store.routines).toHaveLength(1);
    const r = store.routines[0] as Routine;
    expect(r.scope).toBe(SCOPE);
    expect(r.prompt).toBe('llamar a mamá');
    expect(isOneShotReminder(r)).toBe(true);
  });

  it('otro chat, caducado o desconocido: no hace nada y lo dice en español', () => {
    let now = 1_000_000;
    const fired = new FiredReminders(() => now);
    const store = fakeStore();
    const a = fired.remember(SCOPE, 'x');
    expect(
      reminderButtonCommand({ fired, store: store as never, sameChat: () => false }, 'pospone', a),
    ).toBe(FIRED_BUTTON_STALE);
    now += FIRED_BUTTON_MS + 1;
    expect(reminderButtonCommand({ fired, store: store as never, sameChat }, 'pospone', a)).toBe(
      FIRED_BUTTON_STALE,
    );
    expect(
      reminderButtonCommand({ fired, store: store as never, sameChat }, 'hecho', 'ffffffff'),
    ).toBe(FIRED_BUTTON_STALE);
    expect(store.routines).toHaveLength(0);
  });

  it('no guarda avisos sin límite', () => {
    const fired = new FiredReminders(Date.now, 3);
    const first = fired.remember(SCOPE, 'a');
    for (const t of ['b', 'c', 'd']) fired.remember(SCOPE, t);
    expect(fired.take(first, sameChat)).toBeUndefined();
  });

  it('el daemon cablea los botones y /recordatorios atiende hecho|pospone', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain(
      'reminderButtons: (scope, text) => reminderButtons(firedReminders.remember(scope, text))',
    );
    const body = src.slice(src.indexOf('const cmdRecordatorios = async')).slice(0, 1200);
    expect(body).toContain('/^(hecho|pospone|manana) ([0-9a-f]{8})$/');
    expect(body).toContain('sameChat: (s) => chatIdOfScope(s) === inbound.chatId');
  });
});
