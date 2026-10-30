import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';

function fresh(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'pa-routine-save-')), 'db.sqlite'));
}

describe('saveRoutine sobre una rutina que ya existe', () => {
  it('con un id distinto actualiza la fila existente en vez de no guardar nada', () => {
    const store = fresh();
    const first = store.saveRoutine({
      scope: 's',
      name: 'diaria',
      kind: 'schedule',
      prompt: 'a',
      schedule: '0 8 * * *',
    });
    const second = store.saveRoutine({
      id: 'otro-id',
      scope: 's',
      name: 'diaria',
      kind: 'schedule',
      prompt: 'b',
      schedule: '0 9 * * *',
    });
    const saved = store.getRoutine('s', 'diaria');
    expect(saved?.schedule).toBe('0 9 * * *');
    expect(saved?.prompt).toBe('b');
    expect(second.id).toBe(first.id);
    expect(saved?.id).toBe(first.id);
  });

  it('volver a guardarla sin enabled no reactiva una rutina en pausa', () => {
    const store = fresh();
    store.saveRoutine({
      scope: 's',
      name: 'r',
      kind: 'schedule',
      prompt: 'a',
      schedule: '0 8 * * *',
      enabled: false,
    });
    const again = store.saveRoutine({
      scope: 's',
      name: 'r',
      kind: 'schedule',
      prompt: 'a',
      schedule: '5 8 * * *',
    });
    expect(again.enabled).toBe(false);
    expect(store.getRoutine('s', 'r')?.enabled).toBe(false);
    store.saveRoutine({
      scope: 's',
      name: 'r',
      kind: 'schedule',
      prompt: 'a',
      schedule: '5 8 * * *',
      enabled: true,
    });
    expect(store.getRoutine('s', 'r')?.enabled).toBe(true);
  });
});
