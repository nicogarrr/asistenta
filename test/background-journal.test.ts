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

const job = (threadKey: string, task: string, startedAt = 1, id = `${threadKey}|${task}`) => ({
  id,
  threadKey,
  task,
  startedAt,
});

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
    j.remove(job('t#principal', 'busca vuelos').id);
    expect(j.all()).toEqual([job('t#principal', 'resume el informe')]);
    j.remove(job('t#principal', 'resume el informe').id);
    expect(j.all()).toEqual([]);
  });

  it('borrar lo que no está no hace nada', () => {
    const j = new BackgroundJobJournal(file);
    j.add(job('t#principal', 'busca vuelos'));
    j.remove('otro-id');
    expect(j.all()).toHaveLength(1);
  });

  it('el mismo id se reemplaza; dos ejecuciones iguales con ids distintos conviven', () => {
    const j = new BackgroundJobJournal(file);
    j.add(job('t#principal', 'busca vuelos', 1, 'a'));
    j.add(job('t#principal', 'busca vuelos', 2, 'a'));
    expect(j.all()).toEqual([job('t#principal', 'busca vuelos', 2, 'a')]);
    j.add(job('t#principal', 'busca vuelos', 3, 'b'));
    expect(j.all()).toHaveLength(2);
    j.remove('a');
    expect(j.all().map((e) => e.id)).toEqual(['b']);
  });

  it('add sin id asigna uno propio y distinto cada vez', () => {
    const j = new BackgroundJobJournal(file);
    const a = j.add({ threadKey: 't#p', task: 'x', startedAt: 1 });
    const b = j.add({ threadKey: 't#p', task: 'x', startedAt: 1 });
    expect(a).not.toBe(b);
    expect(j.all()).toHaveLength(2);
  });

  it('guarda y devuelve rol, herramientas (incluido []) y resultado', () => {
    const j = new BackgroundJobJournal(file);
    const id = j.add({ threadKey: 't#p', task: 'x', startedAt: 1, role: 'planner', tools: [] });
    j.complete(id, 'nota');
    expect(j.all()).toEqual([
      { id, threadKey: 't#p', task: 'x', startedAt: 1, role: 'planner', tools: [], result: 'nota' },
    ]);
  });

  it('rol o herramientas con forma rara descartan la entrada', () => {
    const j = new BackgroundJobJournal(file);
    writeFileSync(
      file,
      JSON.stringify([
        { threadKey: 't#p', task: 'x', startedAt: 1, role: 'root' },
        { threadKey: 't#p', task: 'y', startedAt: 1, tools: [3] },
      ]),
    );
    expect(j.all()).toEqual([]);
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
    const [only] = j.all();
    expect(j.all()).toHaveLength(1);
    expect(only).toMatchObject({ threadKey: 'x#y', task: 'vale', startedAt: 5 });
    expect(only?.id).toMatch(/^legacy-/);
  });
});
