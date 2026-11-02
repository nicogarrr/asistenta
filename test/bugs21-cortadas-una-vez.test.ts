/**
 * Lo que cortó un reinicio (#1900) se decía en TODOS los turnos hasta el siguiente
 * reinicio: nadie vaciaba la lista, así que horas después, con la tarea retomada y
 * acabada, «¿cómo vas?» seguía contestando «el último reinicio cortó …». Ahora el primer
 * turno del dueño que lo ve lo consume; un tick de objetivo (sin el dueño delante) no.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextNote } from '../src/daemon/context-note.js';
import { Store } from '../src/db.js';
import { MemoryStore } from '../src/memory.js';
import { clearInterrupted, interruptedTasks, trackBusyIn } from '../src/ocupada.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-cortadas-'));
  mkdirSync(join(dir, 'autoupdate'), { recursive: true });
  writeFileSync(
    join(dir, 'autoupdate', 'ocupada.json'),
    JSON.stringify({
      pid: -1,
      turnos: 1,
      aprobaciones: 0,
      items: [{ kind: 'turnos', label: 'instala HyperHDR', since: new Date().toISOString() }],
    }),
  );
  trackBusyIn(dir);
});
afterEach(() => {
  clearInterrupted();
  rmSync(dir, { recursive: true, force: true });
});

const note = (consume?: boolean) => {
  const store = new Store(join(dir, 'db.sqlite'));
  const memory = new MemoryStore(join(dir, 'memory'));
  return buildContextNote(
    { key: 'telegram:1', name: 'main' },
    store,
    memory,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'hola',
    true,
    undefined,
    consume === undefined ? undefined : { consumeInterrupted: consume },
  );
};

describe('tareas cortadas por un reinicio', () => {
  it('el primer turno del dueño lo ve y después ya no se repite', () => {
    expect(interruptedTasks()).toHaveLength(1);
    expect(note(true)).toContain('CORTÓ');
    expect(interruptedTasks()).toHaveLength(0);
    expect(note(true)).not.toContain('CORTÓ');
  });

  it('un turno sin el dueño delante (tick de objetivo) no lo consume', () => {
    expect(note()).toContain('CORTÓ');
    expect(note(false)).toContain('CORTÓ');
    expect(interruptedTasks()).toHaveLength(1);
  });
});
