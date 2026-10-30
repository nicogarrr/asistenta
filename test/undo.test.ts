import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordAfterWrite, recordBeforeWrite, setUndoDir, undoLast } from '../src/undo.js';

let work = '';
let cwd = '';
beforeEach(() => {
  cwd = process.cwd();
  work = mkdtempSync(join(tmpdir(), 'undo-'));
  process.chdir(work);
  setUndoDir(join(work, 'undo'));
});
afterEach(() => {
  setUndoDir(undefined);
  process.chdir(cwd);
});

describe('deshacer la última escritura', () => {
  it('repone el contenido anterior de un fichero sobrescrito', () => {
    const f = join(work, 'a.txt');
    writeFileSync(f, 'original');
    recordBeforeWrite(f);
    writeFileSync(f, 'estropeado');
    recordAfterWrite('estropeado');
    expect(undoLast()).toContain('He repuesto');
    expect(readFileSync(f, 'utf8')).toBe('original');
  });

  it('borra el fichero si lo creó la escritura', () => {
    const f = join(work, 'nuevo.txt');
    recordBeforeWrite(f);
    writeFileSync(f, 'hola');
    recordAfterWrite('hola');
    expect(undoLast()).toContain('no existía');
    expect(existsSync(f)).toBe(false);
  });

  it('una escritura que falló no bloquea deshacer la anterior', () => {
    const f = join(work, 'a.txt');
    writeFileSync(f, 'v1');
    recordBeforeWrite(f);
    writeFileSync(f, 'v2');
    recordAfterWrite('v2');
    // write lanza (EISDIR, EACCES...) después de recordBeforeWrite: el fichero no cambia
    // y nunca llega recordAfterWrite.
    recordBeforeWrite(f);
    expect(undoLast()).toContain('He repuesto');
    expect(readFileSync(f, 'utf8')).toBe('v1');
  });

  it('una creación que falló no bloquea deshacer la anterior', () => {
    const f = join(work, 'a.txt');
    writeFileSync(f, 'v1');
    recordBeforeWrite(f);
    writeFileSync(f, 'v2');
    recordAfterWrite('v2');
    recordBeforeWrite(join(work, 'no-se-creo.txt'));
    expect(undoLast()).toContain('He repuesto');
    expect(readFileSync(f, 'utf8')).toBe('v1');
  });

  it('sin hash y con el fichero cambiado sigue negándose', () => {
    const f = join(work, 'a.txt');
    writeFileSync(f, 'v1');
    recordBeforeWrite(f);
    writeFileSync(f, 'otra cosa');
    expect(undoLast()).toContain('ha cambiado');
    expect(readFileSync(f, 'utf8')).toBe('otra cosa');
  });

  it('deshace de una en una, de la más reciente a la más antigua', () => {
    const f = join(work, 'b.txt');
    writeFileSync(f, 'v1');
    recordBeforeWrite(f);
    writeFileSync(f, 'v2');
    recordAfterWrite('v2');
    recordBeforeWrite(f);
    writeFileSync(f, 'v3');
    recordAfterWrite('v3');
    undoLast();
    expect(readFileSync(f, 'utf8')).toBe('v2');
    undoLast();
    expect(readFileSync(f, 'utf8')).toBe('v1');
    expect(undoLast()).toContain('ninguna escritura');
  });

  it('sin directorio configurado no guarda nada ni lanza', () => {
    setUndoDir(undefined);
    const f = join(work, 'c.txt');
    writeFileSync(f, 'x');
    expect(() => recordBeforeWrite(f)).not.toThrow();
    expect(undoLast()).toContain('ninguna escritura');
  });

  it('la herramienta write guarda la copia antes de sobrescribir', async () => {
    const { writeTool } = await import('../src/tools/fs.js');
    const prev = process.cwd();
    process.chdir(work);
    try {
      writeFileSync(join(work, 'd.txt'), 'antes');
      await writeTool.execute('id', { path: 'd.txt', content: 'despues' } as never);
      expect(readFileSync(join(work, 'd.txt'), 'utf8')).toBe('despues');
      undoLast();
      expect(readFileSync(join(work, 'd.txt'), 'utf8')).toBe('antes');
    } finally {
      process.chdir(prev);
    }
  });

  it('no pisa un fichero que cambió después de la escritura', () => {
    const f = join(work, 'e.txt');
    writeFileSync(f, 'original');
    recordBeforeWrite(f);
    writeFileSync(f, 'de write');
    recordAfterWrite('de write');
    writeFileSync(f, 'trabajo posterior del usuario');
    expect(undoLast()).toContain('ha cambiado');
    expect(readFileSync(f, 'utf8')).toBe('trabajo posterior del usuario');
  });

  it('no borra un fichero nuevo si alguien lo editó después', () => {
    const f = join(work, 'f.txt');
    recordBeforeWrite(f);
    writeFileSync(f, 'de write');
    recordAfterWrite('de write');
    writeFileSync(f, 'editado');
    expect(undoLast()).toContain('ha cambiado');
    expect(existsSync(f)).toBe(true);
  });

  it('no toca rutas fuera del directorio de trabajo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'undo-out-'));
    const f = join(outside, 'g.txt');
    writeFileSync(f, 'ajeno');
    recordBeforeWrite(f);
    writeFileSync(f, 'x');
    recordAfterWrite('x');
    expect(undoLast()).toContain('fuera del directorio');
    expect(readFileSync(f, 'utf8')).toBe('x');
  });
});
