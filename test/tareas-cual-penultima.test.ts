import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'pa-tareas-penultima-')), 'tareas.json');
  const board = new TaskBoard(file, () => NOW);
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
  const call = async (args: Record<string, string>) =>
    ((await tool.execute('t', args as never)).content[0] as { text: string }).text;
  return { board, call };
}

describe('tareas: «la penúltima» al «¿Cuál?»', () => {
  it('elige la penúltima de la lista enseñada', async () => {
    const { board, call } = setup();
    for (const dia of ['lunes', 'martes', 'miércoles']) {
      await call({ action: 'apuntar', titulo: 'llamar al banco', dia });
    }
    const list = await call({ action: 'marcar', tarea: 'banco', estado: 'hecho' });
    expect(list).toMatch(/¿Cuál\?/);
    const ids = [...list.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
    expect(ids).toHaveLength(3);
    const reply = await call({ action: 'marcar', tarea: 'la penúltima', estado: 'hecho' });
    expect(reply).not.toMatch(/No encuentro/);
    const done = board.all().filter((t) => t.status === 'hecho');
    expect(done.map((t) => String(t.id))).toEqual([ids[1]]);
  });

  it('con una sola en la lista no marca nada', async () => {
    const { board, call } = setup();
    await call({ action: 'apuntar', titulo: 'llamar al banco', dia: 'lunes' });
    await call({ action: 'apuntar', titulo: 'llamar al banco', dia: 'martes' });
    await call({ action: 'marcar', tarea: 'banco', estado: 'hecho' });
    await call({ action: 'marcar', tarea: 'la penúltima', estado: 'hecho' });
    expect(board.all().filter((t) => t.status === 'hecho')).toHaveLength(1);
  });
});
