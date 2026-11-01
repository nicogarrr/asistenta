import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

// Miércoles 28 oct 2026 a las 9:00 (hora local).
const NOW = new Date(2026, 9, 28, 9, 0);

function setup() {
  const board = new TaskBoard(
    join(mkdtempSync(join(tmpdir(), 'pa-tareas-')), 'tareas.json'),
    () => NOW,
  );
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9' });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  return { board, call };
}

describe('tareas del día a día', () => {
  it('apuntar lo mismo dos veces no lo duplica', async () => {
    const { board, call } = setup();
    await call({ action: 'apuntar', titulo: 'comprar pan', dia: 'hoy' });
    expect(await call({ action: 'apuntar', titulo: 'Comprar pan', dia: 'hoy' })).toMatch(
      /^Ya lo tenías apuntado para hoy: comprar pan \[\d+\]\.$/,
    );
    expect(board.week('telegram:dm:9').tasks).toHaveLength(1);
    // Otra hora u otro día sí es otra tarea (la pastilla de las 9 y la de las 21).
    await call({ action: 'apuntar', titulo: 'pastilla', dia: 'hoy', hora: '9:00' });
    expect(
      await call({ action: 'apuntar', titulo: 'pastilla', dia: 'hoy', hora: '21:00' }),
    ).toMatch(/^Apuntado/);
    expect(await call({ action: 'apuntar', titulo: 'comprar pan', dia: 'mañana' })).toMatch(
      /^Apuntado/,
    );
  });

  it('«¿qué tengo hoy?» enseña solo hoy y lo atrasado', async () => {
    const { call } = setup();
    await call({ action: 'apuntar', titulo: 'devolver libro', dia: '2026-10-26' });
    await call({ action: 'apuntar', titulo: 'dentista', dia: 'hoy', hora: '17:00' });
    await call({ action: 'apuntar', titulo: 'fontanero', dia: 'viernes' });
    const hoy = await call({ action: 'ver', dia: 'hoy' });
    expect(hoy).toMatch(/^Hoy:\n {2}dentista \(17:00\)/);
    expect(hoy).not.toContain('fontanero');
    expect(hoy).toContain('Sin hacer de antes: devolver libro (lunes 26)');
    expect(await call({ action: 'ver', dia: 'mañana' })).toBe('Mañana no tienes nada apuntado.');
    expect(await call({ action: 'ver', dia: 'viernes' })).toMatch(/^El viernes 30:\n {2}fontanero/);
    expect(await call({ action: 'ver', dia: 'el día de la marmota' })).toMatch(
      /^No entiendo el día/,
    );
    expect(await call({ action: 'ver' })).toMatch(/^Esta semana:/);
  });
});
