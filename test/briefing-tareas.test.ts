import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBriefing } from '../src/briefing.js';
import { composeDailyBriefing } from '../src/briefing-daily.js';
import { briefingTasks, TaskBoard } from '../src/tasks/board.js';

const now = () => new Date(2026, 9, 29, 8, 0); // jueves 29-10-2026, 8:00

function tablero(): TaskBoard {
  const board = new TaskBoard(join(mkdtempSync(join(tmpdir(), 'pa-brief-')), 'tareas.json'), now);
  board.add('telegram:dm:7', 'llamar al banco', '2026-10-29', '10:00');
  board.add('telegram:dm:7#hilo', 'comprar pan', '2026-10-29');
  board.add('telegram:dm:7', 'devolver libro', '2026-10-27');
  board.add('telegram:dm:7', 'fontanero', '2026-10-31');
  board.add('telegram:dm:99', 'de otra persona', '2026-10-29');
  const hecha = board.add('telegram:dm:7', 'ya hecha', '2026-10-29');
  board.setStatus(hecha.id, 'hecho');
  return board;
}

describe('resumen de la mañana: tareas del tablero', () => {
  it('briefingTasks: hoy sin hacer y atrasadas, solo del chat pedido', () => {
    expect(briefingTasks(tablero(), 'telegram:dm:7')).toEqual([
      { title: 'devolver libro', late: true },
      { title: 'llamar al banco', time: '10:00' },
      { title: 'comprar pan' },
    ]);
  });

  it('el resumen las enseña en su bloque', () => {
    const text = buildBriefing({
      greeting: 'Buenos días',
      today: now(),
      routines: [],
      followups: [],
      reminders: [],
      agenda: [],
      tasks: briefingTasks(tablero(), 'telegram:dm:7'),
    });
    expect(text).toContain('Tareas');
    expect(text).toContain('10:00 llamar al banco');
    expect(text).toContain('devolver libro (atrasada)');
    expect(text).not.toContain('fontanero');
    expect(text).not.toContain('otra persona');
  });

  it('con solo tareas para hoy, el resumen no se da por vacío', async () => {
    const r = await composeDailyBriefing({
      now,
      tasks: () => briefingTasks(tablero(), 'telegram:dm:7'),
    } as never);
    expect(r.empty).toBe(false);
    expect(r.text).toContain('comprar pan');
  });
});
