import { describe, expect, it } from 'vitest';
import {
  COMMAND_CALLBACK_PREFIX,
  commandButton,
  commandFromCallback,
} from '../src/channels/telegram-shared.js';
import {
  BUSY_STOP_LABEL,
  busyNoteFor,
  busyStopToken,
  busyThreadForToken,
  isBusyStopToken,
} from '../src/daemon/busy-note.js';

/** «⏹ Pararlo» junto al aviso de cola: corta SOLO la tarea por la que se avisó. */
describe('botón «Pararlo» del aviso de cola', () => {
  it('el aviso trae una ficha de esa tarea que viaja como /stop <ficha>', () => {
    const thread = { chatKey: 'telegram:7', active: true, activeSince: 1_700_000_000_000 };
    expect(busyNoteFor(thread, thread.activeSince + 30_000)).toContain('Sigo con lo anterior');
    const token = busyStopToken(thread);
    expect(token).toBe(`tk${(1_700_000_000_000).toString(36)}`);
    const button = commandButton(BUSY_STOP_LABEL, 'stop', token ?? '');
    expect(button?.action.startsWith(COMMAND_CALLBACK_PREFIX)).toBe(true);
    expect(commandFromCallback(button?.action ?? '')).toBe(`/stop ${token}`);
    expect(isBusyStopToken(token ?? '')).toBe(true);
  });

  it('encuentra solo esa tarea, en ese chat y si sigue en marcha', () => {
    const a = { key: 'a', chatKey: 'telegram:7', active: true, activeSince: 1000 };
    const b = { key: 'b', chatKey: 'telegram:8', active: true, activeSince: 1000 };
    const token = busyStopToken(a) ?? '';
    expect(busyThreadForToken([b, a], 'telegram:7', token)?.key).toBe('a');
    // Botón viejo: la tarea ya terminó y empezó otra.
    const later = { ...a, activeSince: 5000 };
    expect(busyThreadForToken([later], 'telegram:7', token)).toBeUndefined();
    expect(busyThreadForToken([{ ...a, active: false }], 'telegram:7', token)).toBeUndefined();
  });

  it('/stop a secas o con otra cosa sigue siendo el /stop de siempre', () => {
    expect(isBusyStopToken('')).toBe(false);
    expect(isBusyStopToken('todo')).toBe(false);
  });
});
