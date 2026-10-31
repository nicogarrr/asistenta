import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskBoard } from '../src/tasks/board.js';
import { createTasksTool } from '../src/tools/tasks.js';

// Sábado 31 oct 2026 a las 18:30 (hora local).
const NOW = new Date(2026, 9, 31, 18, 30);

async function apuntar(args: Record<string, string>): Promise<string> {
  const board = new TaskBoard(
    join(mkdtempSync(join(tmpdir(), 'pa-tareas-')), 'tareas.json'),
    () => NOW,
  );
  const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:9' });
  const r = await tool.execute('t', { action: 'apuntar', ...args } as never);
  return (r.content[0] as { text: string }).text;
}

describe('tareas: hora que ya ha pasado hoy', () => {
  it('no ofrece recordar algo de hoy a una hora que ya pasó', async () => {
    const r = await apuntar({ titulo: 'llamar a Ana', dia: 'hoy', hora: '10:00' });
    expect(r).toBe(
      'Apuntado para hoy: llamar a Ana a las 10:00. Esa hora ya ha pasado hoy; si era para mañana, dime «pásalo a mañana».',
    );
  });

  it('a una hora que aún no ha llegado, o mañana, sí lo ofrece', async () => {
    expect(await apuntar({ titulo: 'cena', dia: 'hoy', hora: '21:00' })).toMatch(
      /¿Te lo recuerdo a esa hora\?$/,
    );
    expect(await apuntar({ titulo: 'llamar a Ana', dia: 'mañana', hora: '10:00' })).toMatch(
      /¿Te lo recuerdo a esa hora\?$/,
    );
    expect(await apuntar({ titulo: 'pan', dia: 'hoy' })).toBe('Apuntado para hoy: pan.');
  });
});
