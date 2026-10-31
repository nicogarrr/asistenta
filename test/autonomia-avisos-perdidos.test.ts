import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { announceDropped, DROPPED_KEEP, pendingDropped } from '../src/dropped-notice.js';
import { readDroppedReminders, recordDroppedReminder } from '../src/tools/reminder.js';

const NOW = Date.parse('2026-10-31T10:00:00Z');

function file(): string {
  return join(mkdtempSync(join(tmpdir(), 'pa-dropped-')), 'dropped-reminders.jsonl');
}

describe('recordatorios que no se pudieron entregar', () => {
  it('cuando vuelve la conexión avisa UNA vez, en un solo mensaje, y no lo repite', async () => {
    const f = file();
    recordDroppedReminder(
      f,
      'recordatorio-1: llamar al banco @2026-10-31 09:00',
      NOW - 3_600_000,
      '42',
    );
    recordDroppedReminder(
      f,
      'recordatorio-1: sacar la basura @2026-10-31 09:05',
      NOW - 3_000_000,
      '42',
    );
    const send = vi.fn(async () => ({}));
    expect(await announceDropped(f, send, NOW)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [chat, text] = send.mock.calls[0] as unknown as [string, string];
    expect(chat).toBe('42');
    expect(text).toContain('llamar al banco');
    expect(text).toContain('sacar la basura');
    expect(text).not.toMatch(/undefined|null|Error/);
    // Segunda pasada: nada nuevo, nada enviado.
    expect(await announceDropped(f, send, NOW + 300_000)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    // /estado los sigue mostrando.
    expect(readDroppedReminders(f, NOW)).toHaveLength(2);
  });

  it('si sigue sin conexión, lo deja pendiente para el siguiente intento', async () => {
    const f = file();
    recordDroppedReminder(f, 'recordatorio-1: pastilla @2026-10-31 09:00', NOW - 3_600_000, '42');
    const fail = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await announceDropped(f, fail, NOW)).toBe(0);
    expect(pendingDropped(f, NOW).get('42')).toHaveLength(1);
    const ok = vi.fn(async () => ({}));
    expect(await announceDropped(f, ok, NOW + 300_000)).toBe(1);
  });

  it('no avisa de cosas de hace más de una semana ni de entradas sin chat', async () => {
    const f = file();
    recordDroppedReminder(
      f,
      'recordatorio-1: viejo @2026-10-01 09:00',
      NOW - 20 * 86_400_000,
      '42',
    );
    recordDroppedReminder(f, 'recordatorio-1: sin chat @2026-10-31 09:00', NOW - 3_600_000);
    const send = vi.fn(async () => ({}));
    expect(await announceDropped(f, send, NOW)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('el fichero no crece sin límite: al reescribirlo se quedan las últimas entradas', async () => {
    const f = file();
    for (let i = 0; i < DROPPED_KEEP + 30; i++) {
      recordDroppedReminder(
        f,
        `recordatorio-1: aviso ${i} @2026-10-31 09:00`,
        NOW - 3_600_000,
        '42',
      );
    }
    await announceDropped(f, async () => ({}), NOW);
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    expect(lines.length).toBe(DROPPED_KEEP);
    expect(lines.at(-1)).toContain(`aviso ${DROPPED_KEEP + 29}`);
  });
});
