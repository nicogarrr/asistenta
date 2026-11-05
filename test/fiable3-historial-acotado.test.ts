import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoutineHistory } from '../src/routine-history.js';

// Los recordatorios de una vez son rutinas: suenan, se borran y su historial se quedaba
// en state/rutinas-historial.json para siempre (el fichero crecía con cada recordatorio).
let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const run = (at: number) => ({
  at,
  ok: true,
  ms: 5,
  entrega: 'chat' as const,
  salida: 'x'.repeat(300),
});

describe('historial de rutinas acotado', () => {
  it('pasado el tope olvida las rutinas que llevan más tiempo sin ejecutarse', () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-hist-'));
    const path = join(dir, 'rutinas-historial.json');
    const h = new RoutineHistory(path);
    for (let i = 0; i < 260; i++) {
      // Una rutina diaria entre medias: se creó la primera, pero se ejecuta a menudo.
      if (i % 50 === 0) h.record('chat:1', 'diaria', run(1_000 + i));
      h.record('chat:1', `recordatorio-${i}`, run(1_000 + i));
    }
    h.record('chat:1', 'recordatorio-261', run(6_000));

    expect(h.list('chat:1', 'recordatorio-261')).toHaveLength(1);
    expect(h.list('chat:1', 'diaria')).toHaveLength(6);
    expect(h.list('chat:1', 'recordatorio-259')).toHaveLength(1);
    expect(h.list('chat:1', 'recordatorio-0')).toEqual([]);
    expect(h.list('chat:1', 'recordatorio-60')).toEqual([]);
    // 200 rutinas × ~400 B: acotado (sin tope serían 262 y seguiría creciendo).
    expect(statSync(path).size).toBeLessThan(200 * 450);
  });
});
