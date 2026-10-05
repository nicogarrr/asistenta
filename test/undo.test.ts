import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBeforeWrite, setUndoDir, undoLast } from '../src/undo.js';

let work = '';
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'undo-'));
  setUndoDir(join(work, 'undo'));
});
afterEach(() => setUndoDir(undefined));

describe('deshacer la última escritura', () => {
  it('repone el contenido anterior de un fichero sobrescrito', () => {
    const f = join(work, 'a.txt');
    writeFileSync(f, 'original');
    recordBeforeWrite(f);
    writeFileSync(f, 'estropeado');
    expect(undoLast()).toContain('He repuesto');
    expect(readFileSync(f, 'utf8')).toBe('original');
  });

  it('borra el fichero si lo creó la escritura', () => {
    const f = join(work, 'nuevo.txt');
    recordBeforeWrite(f);
    writeFileSync(f, 'hola');
    expect(undoLast()).toContain('no existía');
    expect(existsSync(f)).toBe(false);
  });

  it('deshace de una en una, de la más reciente a la más antigua', () => {
    const f = join(work, 'b.txt');
    writeFileSync(f, 'v1');
    recordBeforeWrite(f);
    writeFileSync(f, 'v2');
    recordBeforeWrite(f);
    writeFileSync(f, 'v3');
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
});
