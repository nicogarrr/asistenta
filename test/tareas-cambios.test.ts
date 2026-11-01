import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'pa-tareas-cambios-')), 'tareas.json');
  const board = new TaskBoard(file, () => NOW);
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9#main' });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  return { board, call };
}

describe('tareas: cambiar hora, nombre y lo atrasado', () => {
  it('«pásalo a las 11» cambia solo la hora y deja el día', async () => {
    const { board, call } = setup();
    await call({ action: 'apuntar', titulo: 'dentista', dia: 'martes', hora: '10' });
    expect(await call({ action: 'mover', tarea: 'dentista', hora: '11:30' })).toBe(
      'Cambiado a las 11:30 del martes 3: dentista.',
    );
    const t = board.all()[0];
    expect([t?.day, t?.time]).toEqual(['2026-11-03', '11:30']);
  });

  it('«quítale la hora» deja la tarea sin hora', async () => {
    const { board, call } = setup();
    await call({ action: 'apuntar', titulo: 'dentista', dia: 'martes', hora: '10' });
    expect(await call({ action: 'mover', tarea: 'dentista', hora: 'sin hora' })).toBe(
      'Sin hora, el martes 3: dentista.',
    );
    expect(board.all()[0]?.time).toBeUndefined();
  });

  it('mover sin día ni hora pregunta', async () => {
    const { call } = setup();
    await call({ action: 'apuntar', titulo: 'dentista', dia: 'martes' });
    expect(await call({ action: 'mover', tarea: 'dentista' })).toBe(
      '¿A qué día o a qué hora la paso?',
    );
  });

  it('renombra una tarea', async () => {
    const { board, call } = setup();
    await call({ action: 'apuntar', titulo: 'llamar al banco', dia: 'lunes' });
    expect(await call({ action: 'renombrar', tarea: 'banco', titulo: 'llamar a la Caixa' })).toBe(
      'Cambiado: «llamar al banco» → «llamar a la Caixa».',
    );
    expect(board.all()[0]?.title).toBe('llamar a la Caixa');
    expect(await call({ action: 'renombrar', tarea: 'caixa' })).toBe('¿Cómo la llamo?');
  });

  it('«pasa lo atrasado a hoy» mueve todas las pendientes de antes', async () => {
    const { board, call } = setup();
    board.add('telegram:dm:9', 'pagar luz', '2026-10-28');
    board.add('telegram:dm:9', 'llamar a mamá', '2026-10-29', '19:00');
    const done = board.add('telegram:dm:9', 'tirar basura', '2026-10-29');
    board.setStatus(done.id, 'hecho');
    board.add('telegram:dm:9', 'comprar pan', '2026-11-02');
    expect(await call({ action: 'mover', tarea: 'lo atrasado', dia: 'hoy' })).toBe(
      'Pasadas a hoy 2 tareas: pagar luz, llamar a mamá.',
    );
    const byTitle = Object.fromEntries(board.all().map((t) => [t.title, t.day]));
    expect(byTitle).toEqual({
      'pagar luz': '2026-10-31',
      'llamar a mamá': '2026-10-31',
      'tirar basura': '2026-10-29',
      'comprar pan': '2026-11-02',
    });
    expect(await call({ action: 'mover', tarea: 'lo atrasado', dia: 'hoy' })).toBe(
      'No tienes nada atrasado.',
    );
  });
});
