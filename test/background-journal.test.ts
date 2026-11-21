import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKGROUND_JOB_KEEP, BackgroundJobJournal } from '../src/core/background-journal.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-bg-journal-'));
  file = join(dir, 'subtareas-fondo.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const job = (threadKey: string, task: string, startedAt = 1) => ({ threadKey, task, startedAt });

describe('BackgroundJobJournal', () => {
  it('sin fichero devuelve vacío', () => {
    expect(new BackgroundJobJournal(file).all()).toEqual([]);
  });

  it('un fichero ilegible se trata como vacío y no tumba nada', () => {
    const j = new BackgroundJobJournal(file);
    j.add(job('t#principal', 'busca vuelos'));
    writeFileSync(file, '{"no":');
    expect(j.all()).toEqual([]);
  });

  it('anota al arrancar y borra al terminar', () => {
    const j = new BackgroundJobJournal(file);
    j.add(job('t#principal', 'busca vuelos'));
    j.add(job('t#principal', 'resume el informe'));
    expect(j.all()).toHaveLength(2);
    j.remove('t#principal', 'busca vuelos');
    expect(j.all()).toEqual([job('t#principal', 'resume el informe')]);
    j.remove('t#principal', 'resume el informe');
    expect(j.all()).toEqual([]);
  });

  it('borrar lo que no está no hace nada', () => {
    const j = new BackgroundJobJournal(file);
    j.add(job('t#principal', 'busca vuelos'));
    j.remove('t#principal', 'otra tarea');
    expect(j.all()).toHaveLength(1);
  });

  it('la misma subtarea dos veces no duplica la entrada', () => {
    const j = new BackgroundJobJournal(file);
    j.add(job('t#principal', 'busca vuelos', 1));
    j.add(job('t#principal', 'busca vuelos', 2));
    expect(j.all()).toEqual([job('t#principal', 'busca vuelos', 2)]);
  });

  it('escritura atómica: el fichero final siempre es JSON válido', () => {
    const j = new BackgroundJobJournal(file);
    j.add(job('t#principal', 'busca vuelos'));
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it(`no guarda más de ${BACKGROUND_JOB_KEEP} entradas`, () => {
    const j = new BackgroundJobJournal(file);
    for (let i = 0; i < BACKGROUND_JOB_KEEP + 5; i++) j.add(job('t#principal', `tarea ${i}`, i));
    const all = j.all();
    expect(all).toHaveLength(BACKGROUND_JOB_KEEP);
    expect(all.at(-1)?.task).toBe(`tarea ${BACKGROUND_JOB_KEEP + 4}`);
  });

  it('descarta entradas con forma rara', () => {
    const j = new BackgroundJobJournal(file);
    writeFileSync(
      file,
      JSON.stringify([{ task: 3 }, { threadKey: 'x#y', task: 'vale', startedAt: 5 }, null]),
    );
    expect(j.all()).toEqual([job('x#y', 'vale', 5)]);
  });
});
