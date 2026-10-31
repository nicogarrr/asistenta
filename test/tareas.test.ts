import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDay, TaskBoard, weekStart } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);

function setup(now = NOW) {
  const file = join(mkdtempSync(join(tmpdir(), 'pa-tareas-')), 'tareas.json');
  const board = new TaskBoard(file, () => now);
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  return { file, board, call };
}

describe('tablero semanal de tareas', () => {
  it('entiende los días en castellano', () => {
    expect(resolveDay('hoy', NOW)).toBe('2026-10-31');
    expect(resolveDay('mañana', NOW)).toBe('2026-11-01');
    expect(resolveDay('el jueves', NOW)).toBe('2026-11-05');
    expect(resolveDay('sábado', NOW)).toBe('2026-10-31');
    expect(resolveDay('jueves que viene', new Date(2026, 9, 27, 12))).toBe('2026-11-05');
    expect(resolveDay('próximo lunes', NOW)).toBe('2026-11-02');
    expect(resolveDay('5/11', NOW)).toBe('2026-11-05');
    expect(resolveDay('2026-12-24', NOW)).toBe('2026-12-24');
    expect(resolveDay('31/02', NOW)).toBeNull();
    expect(resolveDay('cuando sea', NOW)).toBeNull();
    expect(weekStart('2026-11-01')).toBe('2026-10-26');
  });

  it('apunta, enseña la semana y marca hecho por palabras', async () => {
    const { call, file } = setup(new Date(2026, 9, 27, 9, 0)); // martes 27
    expect(
      await call({ action: 'apuntar', titulo: 'llamar al banco', dia: 'jueves', hora: '10' }),
    ).toBe('Apuntado para el jueves 29: llamar al banco a las 10:00. ¿Te lo recuerdo a esa hora?');
    expect(await call({ action: 'apuntar', titulo: 'comprar pienso', dia: 'mañana' })).toBe(
      'Apuntado para el miércoles 28: comprar pienso.',
    );
    await call({ action: 'apuntar', titulo: 'revisar coche', dia: 'jueves que viene' });
    const week = await call({ action: 'ver' });
    expect(week).toBe(
      [
        'Esta semana:',
        'miércoles 28:',
        '  comprar pienso [2]',
        'jueves 29:',
        '  llamar al banco (10:00) [1]',
        '0 de 2 hechas.',
      ].join('\n'),
    );
    expect(await call({ action: 'marcar', tarea: 'lo del banco', estado: 'hecho' })).toBe(
      'Hecho: llamar al banco ✓',
    );
    expect(await call({ action: 'ver' })).toContain('✓ llamar al banco (10:00) [1]');
    expect(await call({ action: 'ver', semana: 'proxima' })).toContain('revisar coche [3]');
    expect(JSON.parse(readFileSync(file, 'utf8')).tasks[0].scope).toBe('telegram:dm:9');
  });

  it('pregunta cuál si hay varias y no inventa', async () => {
    const { call } = setup();
    await call({ action: 'apuntar', titulo: 'llamar a mamá', dia: 'lunes' });
    await call({ action: 'apuntar', titulo: 'llamar al fontanero', dia: 'martes' });
    expect(await call({ action: 'marcar', tarea: 'llamar' })).toMatch(
      /^Hay varias: \[1\] llamar a mamá/,
    );
    expect(await call({ action: 'marcar', tarea: 'dentista' })).toBe(
      'No encuentro ninguna tarea con «dentista».',
    );
    expect(await call({ action: 'apuntar', titulo: 'x', dia: 'cuando pueda' })).toContain(
      'No entiendo el día',
    );
    expect(await call({ action: 'marcar', tarea: '2', estado: 'en curso' })).toBe(
      'llamar al fontanero: en curso.',
    );
    expect(await call({ action: 'mover', tarea: 'fontanero', dia: 'viernes' })).toBe(
      'Movido al viernes 6: llamar al fontanero.',
    );
    expect(await call({ action: 'borrar', tarea: 'mamá' })).toBe('Borrada: llamar a mamá.');
    expect(await call({ action: 'ver', semana: 'proxima' })).not.toContain('mamá');
  });

  it('avisa de lo atrasado sin hacer y separa por chat', async () => {
    const { file, call } = setup();
    const other = new TaskBoard(file, () => NOW);
    other.add('telegram:dm:7', 'cosa de otro', '2026-10-30');
    other.add('telegram:dm:9#otro', 'pagar luz', '2026-10-20');
    const week = await call({ action: 'ver' });
    expect(week).toContain('Esta semana no tienes nada apuntado.');
    expect(week).toContain('Sin hacer de antes: pagar luz (martes 20) [2].');
    expect(week).not.toContain('cosa de otro');
  });

  it('un fichero roto no tumba el tablero', async () => {
    const { file, call } = setup();
    writeFileSync(file, '{roto');
    expect(await call({ action: 'ver' })).toBe('Esta semana no tienes nada apuntado.');
    expect(await call({ action: 'apuntar', titulo: 'algo', dia: 'hoy' })).toBe(
      'Apuntado para hoy: algo.',
    );
  });
});
