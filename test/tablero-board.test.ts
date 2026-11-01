import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normaliseTime,
  resolveDay,
  resolveStatus,
  TaskBoard,
  weekStart,
} from '../src/tasks/board.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);
const fresh = () => join(mkdtempSync(join(tmpdir(), 'pa-tablero-')), 'tareas.json');

describe('tablero semanal: días, estados y fichero', () => {
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
    expect(resolveStatus('Hecho')).toBe('hecho');
    expect(resolveStatus('en curso')).toBe('en_curso');
    expect(resolveStatus('quizá')).toBeNull();
    expect(normaliseTime('10')).toBe('10:00');
    expect(normaliseTime('25:00')).toBeNull();
  });

  it('guarda por chat, busca por palabras y separa la semana de lo atrasado', () => {
    const file = fresh();
    const board = new TaskBoard(file, () => NOW);
    board.add('telegram:dm:9#main', 'Llamar al banco', '2026-10-29', '10:00');
    board.add('telegram:dm:9#otro', 'pagar luz', '2026-10-20');
    board.add('telegram:dm:7', 'cosa de otro', '2026-10-30');
    const again = new TaskBoard(file, () => NOW);
    expect(again.find('telegram:dm:9', 'lo del banco').map((t) => t.id)).toEqual([1]);
    expect(again.find('telegram:dm:9', '3')).toEqual([]);
    const w = again.week('telegram:dm:9');
    expect([w.from, w.to]).toEqual(['2026-10-26', '2026-11-01']);
    expect(w.tasks.map((t) => t.title)).toEqual(['Llamar al banco']);
    expect(w.overdue.map((t) => t.title)).toEqual(['pagar luz']);
    again.setStatus(2, 'hecho');
    expect(again.week('telegram:dm:9').overdue).toEqual([]);
    expect(again.remove(1)?.title).toBe('Llamar al banco');
    expect(again.all('telegram:dm:9').map((t) => t.id)).toEqual([2]);
  });

  it('un fichero roto no tumba el tablero', () => {
    const file = fresh();
    writeFileSync(file, '{roto');
    const board = new TaskBoard(file, () => NOW);
    expect(board.all()).toEqual([]);
    expect(board.add('telegram:dm:9', 'algo', '2026-10-31').id).toBe(1);
  });
});
