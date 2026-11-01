import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefingTasks, TaskBoard } from '../src/tasks/board.js';

describe('tarea atrasada: el resumen avisa una sola vez', () => {
  it('sale el primer día, otra vez ese mismo día, y no las mañanas siguientes', () => {
    let hoy = new Date(2026, 9, 29, 8, 0); // jueves 29-10-2026
    const file = join(mkdtempSync(join(tmpdir(), 'pa-atrasada-')), 'tareas.json');
    const board = new TaskBoard(file, () => hoy);
    board.add('telegram:dm:7', 'devolver libro', '2026-10-27');
    board.add('telegram:dm:7', 'llamar al banco', '2026-10-29', '10:00');
    const titulos = () => briefingTasks(board, 'telegram:dm:7').map((t) => t.title);

    expect(titulos()).toEqual(['devolver libro', 'llamar al banco']);
    expect(titulos()).toEqual(['devolver libro', 'llamar al banco']); // resumen repetido hoy
    hoy = new Date(2026, 9, 30, 8, 0);
    // El banco (de ayer) se atrasa hoy: sale una vez; el libro ya no.
    expect(titulos()).toEqual(['llamar al banco']);
    hoy = new Date(2026, 9, 31, 8, 0);
    expect(titulos()).toEqual([]);
    // Sigue en el tablero como atrasada.
    expect(board.find('telegram:dm:7', 'libro')[0]?.status).toBe('pendiente');
  });

  it('si se cambia de día y vuelve a atrasarse, avisa otra vez (una)', () => {
    let hoy = new Date(2026, 9, 29, 8, 0);
    const file = join(mkdtempSync(join(tmpdir(), 'pa-atrasada-')), 'tareas.json');
    const board = new TaskBoard(file, () => hoy);
    const t = board.add('telegram:dm:7', 'fontanero', '2026-10-28');
    expect(briefingTasks(board, 'telegram:dm:7')).toEqual([{ title: 'fontanero', late: true }]);
    board.move(t.id, '2026-10-30');
    hoy = new Date(2026, 10, 2, 8, 0); // lunes 2-11
    expect(briefingTasks(board, 'telegram:dm:7')).toHaveLength(1);
    hoy = new Date(2026, 10, 3, 8, 0);
    expect(briefingTasks(board, 'telegram:dm:7')).toHaveLength(0);
  });
});
