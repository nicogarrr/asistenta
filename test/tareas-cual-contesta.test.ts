import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'pa-tareas-cual-')), 'tareas.json');
  const board = new TaskBoard(file, () => NOW);
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  return { board, call };
}

async function twoBanks() {
  const s = setup();
  await s.call({ action: 'apuntar', titulo: 'llamar al banco', dia: 'viernes' });
  await s.call({ action: 'apuntar', titulo: 'llamar al banco', dia: 'lunes' });
  return s;
}

const statusOf = (board: TaskBoard, day: string) => board.all().find((t) => t.day === day)?.status;

describe('tareas: contestar al «Hay varias… ¿Cuál?»', () => {
  it('«la del viernes» elige la del viernes', async () => {
    const { board, call } = await twoBanks();
    expect(await call({ action: 'marcar', tarea: 'banco', estado: 'hecho' })).toMatch(/¿Cuál\?/);
    await call({ action: 'marcar', tarea: 'la del viernes', estado: 'hecho' });
    expect(statusOf(board, '2026-11-06')).toBe('hecho');
    expect(statusOf(board, '2026-11-02')).toBe('pendiente');
  });

  it('«la segunda» y «la última» eligen por orden de la lista', async () => {
    const { board, call } = await twoBanks();
    const list = await call({ action: 'marcar', tarea: 'banco', estado: 'hecho' });
    const second = /; \[(\d+)\]/.exec(list)?.[1];
    await call({ action: 'marcar', tarea: 'la segunda', estado: 'hecho' });
    expect(board.all().find((t) => String(t.id) === second)?.status).toBe('hecho');

    const { board: b2, call: c2 } = await twoBanks();
    const l2 = await c2({ action: 'mover', tarea: 'banco', dia: 'martes' });
    const last = /; \[(\d+)\]/.exec(l2)?.[1];
    await c2({ action: 'mover', tarea: 'la última', dia: 'martes' });
    expect(b2.all().find((t) => String(t.id) === last)?.day).toBe('2026-11-03');
  });

  it('«lo del banco del lunes» sirve aunque no haya lista antes', async () => {
    const { board, call } = await twoBanks();
    await call({ action: 'marcar', tarea: 'lo del banco del lunes', estado: 'hecho' });
    expect(statusOf(board, '2026-11-02')).toBe('hecho');
    expect(statusOf(board, '2026-11-06')).toBe('pendiente');
  });

  it('«la segunda» sin lista antes no adivina', async () => {
    const { board, call } = await twoBanks();
    expect(await call({ action: 'marcar', tarea: 'la segunda', estado: 'hecho' })).toMatch(
      /No encuentro/,
    );
    expect(board.all().every((t) => t.status === 'pendiente')).toBe(true);
  });

  it('un título que lleva un día sigue encontrándose tal cual', async () => {
    const { board, call } = setup();
    await call({ action: 'apuntar', titulo: 'regalo del viernes', dia: 'hoy' });
    await call({ action: 'marcar', tarea: 'regalo del viernes', estado: 'hecho' });
    expect(board.all()[0]?.status).toBe('hecho');
  });
});
