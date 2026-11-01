import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextOccurrence, resolveRepeat, TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

function setup(start: Date) {
  const file = join(mkdtempSync(join(tmpdir(), 'pa-tareas-quincenal-')), 'tareas.json');
  const board = new TaskBoard(file, () => start);
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
  const call = async (args: Record<string, string>) =>
    ((await tool.execute('t', args as never)).content[0] as { text: string }).text;
  return { board, call };
}

describe('tareas: «los lunes» y «cada dos semanas»', () => {
  it('«los lunes» sin «todos» o «cada» es cada semana', () => {
    expect(resolveRepeat('los lunes')).toBe('semanal');
    expect(resolveRepeat('los sábados')).toBe('semanal');
    expect(resolveRepeat('los domingos')).toBe('semanal');
    // Sin plural no es una repetición: «el lunes» es un día.
    expect(resolveRepeat('el lunes')).toBeNull();
    expect(resolveRepeat('lunes')).toBeNull();
  });

  it('«cada dos semanas» se repite a los 14 días', () => {
    expect(resolveRepeat('cada dos semanas')).toBe('quincenal');
    expect(resolveRepeat('cada 2 semanas')).toBe('quincenal');
    expect(resolveRepeat('cada quince días')).toBe('quincenal');
    expect(resolveRepeat('una semana sí y otra no')).toBe('quincenal');
    expect(nextOccurrence('2026-11-02', 'quincenal')).toBe('2026-11-16');
    expect(nextOccurrence('2026-12-28', 'quincenal')).toBe('2027-01-11');
  });

  it('apuntada cada dos semanas, al hacerla sale la de dentro de 14 días', async () => {
    const { board, call } = setup(new Date(2026, 10, 2, 9)); // lunes 2 nov
    expect(
      await call({
        action: 'apuntar',
        titulo: 'regar las plantas',
        dia: 'hoy',
        repetir: 'cada dos semanas',
      }),
    ).toBe('Apuntado para hoy: regar las plantas (cada dos semanas).');
    const t = board.week('telegram:dm:9', '2026-11-02').tasks[0];
    expect(t?.repeat).toBe('quincenal');
    await call({ action: 'marcar', tarea: 'regar las plantas', estado: 'hecho' });
    const next = board.week('telegram:dm:9', '2026-11-16').tasks.find((o) => o.status !== 'hecho');
    expect(next?.day).toBe('2026-11-16');
  });

  it('«apunta sacar la basura los lunes» guarda la repetición', async () => {
    const { call } = setup(new Date(2026, 10, 2, 9));
    expect(
      await call({
        action: 'apuntar',
        titulo: 'sacar la basura',
        dia: 'lunes',
        repetir: 'los lunes',
      }),
    ).toBe('Apuntado para hoy: sacar la basura (cada semana).');
  });
});
