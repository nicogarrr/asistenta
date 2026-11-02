import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';
import { resumenSesion } from '../src/webui/client-format.js';

describe('textos de fecha y número', () => {
  it('«pasa lo atrasado a hoy» con una sola tarea concuerda en singular', async () => {
    const now = new Date(2026, 9, 31, 12, 0);
    const file = join(mkdtempSync(join(tmpdir(), 'pa-bugs17-singular-')), 'tareas.json');
    const board = new TaskBoard(file, () => now);
    const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
    board.add('telegram:dm:9', 'pagar luz', '2026-10-28');
    const r = await tool.execute('t', {
      action: 'mover',
      tarea: 'lo atrasado',
      dia: 'hoy',
    } as never);
    expect((r.content[0] as { text: string }).text).toBe('Pasada a hoy 1 tarea: pagar luz.');
  });

  it('panel: «Ayer» también el lunes a las 00:30 tras pasar al horario de verano', () => {
    // vitest corre con TZ=Europe/Madrid; el domingo 29 de marzo de 2026 dura 23 h.
    const ahora = new Date(2026, 2, 30, 0, 30).getTime();
    const sesion = {
      title: 'Compra',
      startedAt: new Date(2026, 2, 29, 12, 0).getTime(),
      endedAt: 1,
    };
    expect(resumenSesion(sesion, 0, ahora).meta).toContain('Ayer, 12:00');
    const anteayer = { ...sesion, startedAt: new Date(2026, 2, 28, 23, 45).getTime() };
    expect(resumenSesion(anteayer, 0, ahora).meta).toContain('28/03, 23:45');
  });
});
