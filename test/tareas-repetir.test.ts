import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextOccurrence, resolveRepeat, TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

function setup(start: Date) {
  let now = start;
  const file = join(mkdtempSync(join(tmpdir(), 'pa-tareas-repetir-')), 'tareas.json');
  const board = new TaskBoard(file, () => now);
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  const at = (d: Date) => {
    now = d;
  };
  return { board, call, at };
}

describe('tareas que se repiten', () => {
  it('entiende cómo se dice que se repite', () => {
    expect(resolveRepeat('todos los lunes')).toBe('semanal');
    expect(resolveRepeat('cada semana')).toBe('semanal');
    expect(resolveRepeat('todos los días')).toBe('diario');
    expect(resolveRepeat('de lunes a viernes')).toBe('laborables');
    expect(resolveRepeat('cada mes')).toBe('mensual');
    expect(resolveRepeat('no')).toBe('no');
    expect(resolveRepeat('cuando me acuerde')).toBeNull();
    expect(nextOccurrence('2026-10-30', 'laborables')).toBe('2026-11-02');
    expect(nextOccurrence('2026-01-31', 'mensual')).toBe('2026-02-28');
  });

  it('«todos los lunes sacar la basura»: al marcarla hecha sale la del lunes siguiente', async () => {
    const { board, call } = setup(new Date(2026, 10, 2, 9)); // lunes 2 nov
    expect(
      await call({
        action: 'apuntar',
        titulo: 'sacar la basura',
        dia: 'lunes',
        repetir: 'todos los lunes',
      }),
    ).toBe('Apuntado para hoy: sacar la basura (cada semana).');
    expect(await call({ action: 'marcar', tarea: 'basura', estado: 'hecho' })).toBe(
      'Hecho: sacar la basura ✓ La próxima, el lunes 9.',
    );
    const open = board.all().filter((t) => t.status !== 'hecho');
    expect(open.map((t) => [t.title, t.day, t.repeat])).toEqual([
      ['sacar la basura', '2026-11-09', 'semanal'],
    ]);
    expect(await call({ action: 'ver', semana: 'proxima' })).toContain(
      'sacar la basura (cada semana)',
    );
  });

  it('una repetida sin hacer no se queda atrasada: salta a la siguiente', async () => {
    const { board, call, at } = setup(new Date(2026, 10, 2, 9));
    await call({ action: 'apuntar', titulo: 'regar plantas', dia: 'hoy', repetir: 'cada día' });
    at(new Date(2026, 10, 5, 9)); // jueves, sin marcarla
    expect(board.week('telegram:dm:9').overdue).toEqual([]);
    expect(board.all().map((t) => t.day)).toEqual(['2026-11-05']);
  });

  it('deja de repetir y vuelve a repetir con «repetir»', async () => {
    const { board, call } = setup(new Date(2026, 10, 2, 9));
    await call({ action: 'apuntar', titulo: 'pagar alquiler', dia: '2/11' });
    expect(await call({ action: 'repetir', tarea: 'alquiler', repetir: 'cada mes' })).toBe(
      'Ahora «pagar alquiler» se repite cada mes.',
    );
    expect(await call({ action: 'repetir', tarea: 'alquiler', repetir: 'no' })).toBe(
      'Ya no se repite: pagar alquiler.',
    );
    expect(board.all()[0]?.repeat).toBeUndefined();
    expect(await call({ action: 'repetir', tarea: 'alquiler', repetir: 'a veces' })).toMatch(
      /^No entiendo cada cuánto/,
    );
  });
});
