/**
 * La nota del turno decía «Abierto ahora: …» quitando los turnos abiertos con el MISMO texto
 * que el mensaje actual, para no contarse a sí mismo. Pero la nota se arma antes de que el
 * turno se abra (busyBegin va dentro de agent.run), así que ese filtro solo escondía otro
 * turno de verdad: si una tarea se colgaba y Nico volvía a mandar lo mismo («instala
 * HyperHDR»), la nota callaba la colgada y el modelo contestaba «no hay nada a medias».
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextNote } from '../src/daemon/context-note.js';
import { Store } from '../src/db.js';
import { MemoryStore } from '../src/memory.js';
import { busyBegin, clearInterrupted } from '../src/ocupada.js';

let dir: string;
const closers: Array<() => void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-abierto-'));
});
afterEach(() => {
  for (const c of closers.splice(0)) c();
  clearInterrupted();
  rmSync(dir, { recursive: true, force: true });
});

const note = (request: string) => {
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
    request,
    true,
  );
};

describe('«Abierto ahora» en la nota del turno', () => {
  it('dice la tarea colgada aunque Nico vuelva a mandar el mismo texto', () => {
    closers.push(busyBegin('turnos', 'instala HyperHDR'));
    expect(note('instala HyperHDR')).toContain(
      'Abierto ahora: una tarea desde hace 0 min («instala HyperHDR»)',
    );
  });

  it('con otro texto también, y un permiso sin responder', () => {
    closers.push(busyBegin('turnos', 'resume el correo'));
    closers.push(busyBegin('aprobaciones', 'permiso'));
    const n = note('¿cómo vas?');
    expect(n).toContain('«resume el correo»');
    expect(n).toContain('un permiso sin responder');
  });

  it('sin nada abierto no hay línea', () => {
    expect(note('hola')).not.toContain('Abierto ahora');
  });
});
