import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContextNote } from '../src/daemon/context-note.js';
import { Store } from '../src/db.js';
import { knownDates } from '../src/memory/fechas.js';
import { factKey, forgetRequest, statedFact, supersededBy } from '../src/memory/owner-facts.js';
import { MemorySnapshot } from '../src/memory/snapshot.js';
import { MemoryStore } from '../src/memory.js';

/**
 * Datos de Nico que antes iban al modelo y no se apuntaban: la edad, la profesión, costumbres
 * («uso gafas»), «mi hermana nació el…»; y «ya no tengo coche», que no borraba el dato viejo.
 */
describe('se apuntan', () => {
  it.each([
    'tengo 34 años',
    'soy médico',
    'Soy ingeniera informática',
    'soy profesor de instituto',
    'trabajo desde casa los viernes',
    'uso gafas para leer',
    'mi hermana nació el 29 de febrero',
    'Javi nació el 3 de mayo',
  ])('«%s»', (said) => {
    expect(statedFact(said)).not.toBeNull();
  });

  it.each([
    'tengo 34 años que no veo a Ana',
    'soy muy puntual',
    'soy yo',
    'soy médico? no sé',
    'mi hermana nació el año pasado',
  ])('no: «%s»', (said) => {
    expect(statedFact(said)).toBeNull();
  });

  it('la edad y la profesión nuevas sustituyen a las viejas', () => {
    expect(supersededBy(['[dicho] Tengo 33 años'], 'Tengo 34 años')).toEqual([
      '[dicho] Tengo 33 años',
    ]);
    expect(supersededBy(['[dicho] Soy estudiante'], 'Soy médico')).toEqual([
      '[dicho] Soy estudiante',
    ]);
    expect(factKey('Soy del Atleti')).not.toBe('profesion');
    expect(factKey('Soy muy puntual')).toBeNull();
    expect(factKey('Mi hermana nació el 29 de febrero')).toBe('cumple|mi hermana');
  });
});

describe('«nació el» es un cumpleaños', () => {
  it('sale en las fechas', () => {
    expect(knownDates(['[dicho] Mi hermana nació el 29 de febrero'])).toEqual([
      { label: 'cumple de tu hermana', month: 2, day: 29 },
    ]);
    expect(knownDates(['[dicho] Nací el 3 de mayo de 1992'])).toEqual([
      { label: 'tu cumpleaños', month: 5, day: 3 },
    ]);
  });
});

describe('«ya no…» borra lo apuntado', () => {
  it.each([
    ['ya no tengo coche', 'coche'],
    ['Ya no tengo el perro', 'perro'],
    ['ya no vivo en Madrid', 'vivo en Madrid'],
    ['ya no trabajo en Indra', 'trabajo en Indra'],
    ['ya no soy vegetariano', 'soy vegetarian'],
    ['ya no juego al pádel', 'juego al pádel'],
  ])('«%s» → %s', (said, query) => {
    expect(forgetRequest(said)).toEqual({ kind: 'match', query });
  });

  it('no es un «ya no» de los que se apuntan', () => {
    expect(forgetRequest('ya no tengo ganas de nada hoy la verdad')).toBeNull();
    expect(forgetRequest('ya no me acuerdo')).toBeNull();
  });
});

describe('<fechas> en el turno: solo hoy y mañana', () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const c of closers.splice(0)) c();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const note = (entries: string[]): string => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T09:00:00Z'));
    const dir = mkdtempSync(join(tmpdir(), 'ag3-fechas-'));
    dirs.push(dir);
    const store = new Store(join(dir, 'db.sqlite'));
    closers.push(() => store.close());
    const snapshot = new MemorySnapshot({ dir: join(dir, 'snapshot') });
    for (const e of entries) snapshot.appendEntry(e);
    return buildContextNote(
      { key: 'telegram:1', name: 'main' },
      store,
      new MemoryStore(join(dir, 'memory')),
      snapshot,
      undefined,
      undefined,
      undefined,
      undefined,
      'hola',
      true,
    );
  };

  it('un cumple dentro de 3 días ya no sale en cada turno (lo dice el resumen de la mañana)', () => {
    expect(note(['[dicho] El cumple de mi madre es el 8 de noviembre'])).not.toContain('<fechas>');
  });

  it('mañana sí', () => {
    expect(note(['[dicho] Mi hermana nació el 6 de noviembre'])).toContain('cumple de su hermana');
  });
});
