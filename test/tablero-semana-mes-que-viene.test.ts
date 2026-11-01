import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDay, TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);

describe('tablero: «la semana que viene» y «el mes que viene»', () => {
  it('la semana que viene es su lunes', () => {
    expect(resolveDay('la semana que viene', NOW)).toBe('2026-11-02');
    expect(resolveDay('para la semana que viene', NOW)).toBe('2026-11-02');
    expect(resolveDay('la próxima semana', NOW)).toBe('2026-11-02');
    expect(resolveDay('la semana siguiente', NOW)).toBe('2026-11-02');
    // Un lunes: la semana que viene empieza dentro de 7 días, no hoy.
    expect(resolveDay('la semana que viene', new Date(2026, 10, 2, 9))).toBe('2026-11-09');
  });

  it('el mes que viene es su día 1, también en diciembre', () => {
    expect(resolveDay('el mes que viene', NOW)).toBe('2026-11-01');
    expect(resolveDay('el próximo mes', NOW)).toBe('2026-11-01');
    expect(resolveDay('para el mes que viene', new Date(2026, 11, 20, 12))).toBe('2027-01-01');
  });

  it('«dentro de un mes» es el mismo día del mes que toca', () => {
    expect(resolveDay('dentro de un mes', NOW)).toBe('2026-11-30');
    expect(resolveDay('en dos meses', NOW)).toBe('2026-12-31');
    expect(resolveDay('dentro de 3 meses', new Date(2026, 10, 15, 12))).toBe('2027-02-15');
  });

  it('no cambia lo que ya se entendía', () => {
    expect(resolveDay('el lunes de la semana que viene', NOW)).toBe('2026-11-02');
    expect(resolveDay('el jueves que viene', NOW)).toBe('2026-11-05');
    expect(resolveDay('la semana', NOW)).toBeNull();
  });

  it('apunta y enseña la semana que viene entera', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pa-tablero-semana-')), 'tareas.json');
    const board = new TaskBoard(file, () => NOW);
    const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
    const call = async (args: Record<string, string>) =>
      ((await tool.execute('t', args as never)).content[0] as { text: string }).text;
    const added = await call({
      action: 'apuntar',
      titulo: 'renovar el DNI',
      dia: 'la semana que viene',
    });
    expect(added).not.toMatch(/No entiendo/);
    expect(added).toMatch(/lunes 2/);
    await call({ action: 'apuntar', titulo: 'pagar el seguro', dia: 'viernes 6' });
    const seen = await call({ action: 'ver', dia: 'la semana que viene' });
    expect(seen).toMatch(/renovar el DNI/);
    expect(seen).toMatch(/pagar el seguro/);
  });
});
