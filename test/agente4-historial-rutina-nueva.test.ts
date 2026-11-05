import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoutineHistory, routineHistoryAt } from '../src/routine-history.js';

const run = (at: number, ok: boolean) => ({
  at,
  ok,
  ms: 10,
  entrega: 'chat' as const,
  salida: ok ? 'bien' : 'falló',
});

/**
 * Borrar la rutina «resumen» y crear otra «resumen» heredaba el historial de la vieja: /cron
 * historial enseñaba sus ejecuciones y /cron decía «❌ la última falló» de una rutina que ya
 * no existía. Ahora el historial solo enseña lo de después de crear la rutina de hoy.
 */
describe('historial de una rutina borrada y vuelta a crear', () => {
  it('no enseña las ejecuciones de la rutina vieja con el mismo nombre', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag4-hist-'));
    try {
      let born = '2026-11-01T08:00:00.000Z';
      const h = routineHistoryAt(dir, () => born);
      h.record('telegram:1#main', 'resumen', run(Date.parse('2026-11-02T08:00:00Z'), false));
      expect(h.list('telegram:1#main', 'resumen')).toHaveLength(1);
      // Se borra y se crea otra «resumen» el día 4.
      born = '2026-11-04T09:00:00.000Z';
      expect(h.list('telegram:1#main', 'resumen')).toEqual([]);
      h.record('telegram:1#main', 'resumen', run(Date.parse('2026-11-05T08:00:00Z'), true));
      expect(h.list('telegram:1#main', 'resumen').map((r) => r.ok)).toEqual([true]);
      // Lo viejo sigue en el fichero (acotado), pero no se enseña.
      expect(readFileSync(join(dir, 'rutinas-historial.json'), 'utf8')).toContain('falló');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sin saber cuándo se creó (o sin fecha legible), igual que antes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag4-hist-'));
    try {
      const plain = new RoutineHistory(join(dir, 'h.json'));
      plain.record('s', 'r', run(1, true));
      expect(plain.list('s', 'r')).toHaveLength(1);
      const odd = new RoutineHistory(join(dir, 'h.json'), () => 'no es una fecha');
      expect(odd.list('s', 'r')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el daemon le dice al historial cuándo se creó cada rutina', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).not.toMatch(/routineHistoryAt\(paths\.state\)/);
    expect(cli).toMatch(/store\.getRoutine\(scope, name\)\?\.createdAt/);
  });
});
