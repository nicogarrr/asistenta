import { describe, expect, it } from 'vitest';
import { BUSY_NOTE, BUSY_NOTE_AFTER_MS, busyNoteFor } from '../src/daemon/busy-note.js';

describe('aviso de cola: un mensaje que espera detrás de una tarea larga', () => {
  it('avisa una vez por tarea, solo si lleva un rato, y apunta a /btw', () => {
    const t0 = 1_000_000;
    const thread: Parameters<typeof busyNoteFor>[0] = { active: true, activeSince: t0 };
    expect(busyNoteFor(thread, t0 + 5_000)).toBeNull();
    expect(busyNoteFor(thread, t0 + BUSY_NOTE_AFTER_MS)).toBe(BUSY_NOTE);
    expect(BUSY_NOTE).toContain('/btw');
    // Segundo mensaje durante la misma tarea: sin repetir.
    expect(busyNoteFor(thread, t0 + 60_000)).toBeNull();
    // Tarea nueva: vuelve a avisar.
    thread.activeSince = t0 + 120_000;
    expect(busyNoteFor(thread, t0 + 200_000)).toBe(BUSY_NOTE);
  });

  it('sin nada en marcha no dice nada', () => {
    expect(busyNoteFor({ active: false, activeSince: 1 }, 1_000_000)).toBeNull();
    expect(busyNoteFor({ active: true }, 1_000_000)).toBeNull();
  });

  it('el daemon lo da al encolar un mensaje y marca cuándo empieza cada turno', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const queue = cli.indexOf('void queueMessageTurn(');
    const note = cli.lastIndexOf('busyNoteFor(thread, Date.now())', queue);
    expect(note).toBeGreaterThan(0);
    expect(queue - note).toBeLessThan(800);
    expect(cli).toMatch(/thread\.active = true;\n\s*thread\.activeSince = Date\.now\(\);/);
  });
});
