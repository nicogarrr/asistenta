import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROGRESS_FIRST_MS,
  PROGRESS_HEARTBEAT_MS,
  ProgressMilestones,
} from '../src/daemon/progress-milestone.js';

/** Simula el temporizador de 5 s del turno y cuenta las notas que saldrían. */
function run(totalMs: number, stepAt: (ms: number) => string | null): number[] {
  const p = new ProgressMilestones();
  const t0 = 1_000_000;
  const notes: number[] = [];
  for (let ms = 5_000; ms <= totalMs; ms += 5_000) {
    const step = stepAt(ms);
    if (p.due(ms, t0 + ms, step)) {
      p.shown(t0 + ms, step);
      notes.push(ms);
    }
  }
  return notes;
}

describe('nota de progreso: solo en hitos reales', () => {
  it('un turno de 50 s no saca nota (basta el acuse corto)', () => {
    expect(run(50_000, () => 'leyendo la web')).toEqual([]);
  });

  it('la primera nota sale al minuto', () => {
    expect(run(65_000, () => 'leyendo la web')[0]).toBe(PROGRESS_FIRST_MS);
  });

  it('el mismo paso 5 min: nada de goteo cada 45 s, solo un recordatorio cada 3 min', () => {
    const notes = run(300_000, () => 'leyendo la web');
    expect(notes).toEqual([PROGRESS_FIRST_MS, PROGRESS_FIRST_MS + PROGRESS_HEARTBEAT_MS]);
  });

  it('un paso nuevo sí se cuenta (pasados 45 s de la anterior)', () => {
    const notes = run(200_000, (ms) => (ms < 90_000 ? 'leyendo la web' : 'mirando tu correo'));
    expect(notes).toEqual([60_000, 105_000]);
  });

  it('cli.ts usa los hitos en vez del reloj de 25 s / 45 s', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/now - startedAt > 25_000 && now - lastStatusAt > 45_000/);
    expect(src).toMatch(/milestones\.due\(now - startedAt, now, lastSummary\)/);
  });
});
