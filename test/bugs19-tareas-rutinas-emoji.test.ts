import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { TaskBoard } from '../src/tasks/board.js';
import { parkFailedRepeating } from '../src/tools/reminder.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs19-cortes-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// asis-bugs-19: el título de una tarea se cortaba a 200 unidades UTF-16 y el nombre de
// una rutina de recordatorio a 60 a ciegas; un emoji justo en el corte quedaba partido.
describe('tareas y rutinas: cortes sin medio emoji', () => {
  it('una tarea con emoji en el carácter 200, al crearla y al renombrarla', () => {
    const board = new TaskBoard(join(dir, 'tareas.json'), () => new Date(2026, 10, 2, 10, 0));
    const title = `${'a'.repeat(199)}🎂 cumple`;
    const task = board.add('tg:1:2', title, '2026-11-03');
    expect(task.title).toBe('a'.repeat(199));
    expect(task.title).not.toMatch(LONE);
    const renamed = board.rename(task.id, `${'b'.repeat(199)}🩺 médico`);
    expect(renamed?.title).toBe('b'.repeat(199));
    expect(renamed?.title).not.toMatch(LONE);
  });

  it('el nombre de la rutina de un recordatorio con emoji en el carácter 60', () => {
    const store = new Store(join(dir, 'db.sqlite'));
    try {
      const name = parkFailedRepeating(
        store,
        { scope: 'tg:1:2', name: 'recordatorio x', prompt: `${'c'.repeat(59)}💊 pastilla` },
        Date.parse('2026-11-02T09:00:00Z'),
      );
      expect(name).toContain('c'.repeat(59));
      expect(name).not.toMatch(LONE);
    } finally {
      store.close();
    }
  });
});
