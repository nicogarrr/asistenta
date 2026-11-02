import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordAfterWrite, recordBeforeWrite, setUndoDir, undoLast } from '../src/undo.js';

// bugs16: /deshacer le decía a Nico la hora de la escritura en UTC («05:23 UTC» cuando en
// Madrid eran las 06:23). Ahora, como todo lo demás, en su hora local.
let work = '';
let cwd = '';
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  cwd = process.cwd();
  work = mkdtempSync(join(tmpdir(), 'undo-hora-'));
  process.chdir(work);
  setUndoDir(join(work, 'undo'));
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterEach(() => {
  setUndoDir(undefined);
  process.chdir(cwd);
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
});

const AT = new Date(Date.UTC(2026, 10, 2, 5, 23)); // 06:23 en Madrid

describe('deshacer: la hora de la escritura en hora local', () => {
  it('fichero sobrescrito: «06:23», no «05:23 UTC»', () => {
    const f = join(work, 'a.txt');
    writeFileSync(f, 'original');
    recordBeforeWrite(f, AT);
    writeFileSync(f, 'estropeado');
    recordAfterWrite('estropeado');
    const out = undoLast();
    expect(out).toContain('He repuesto');
    expect(out).toContain('2026-11-02 06:23');
    expect(out).not.toContain('UTC');
  });

  it('fichero creado: igual', () => {
    const f = join(work, 'nuevo.txt');
    recordBeforeWrite(f, AT);
    writeFileSync(f, 'hola');
    recordAfterWrite('hola');
    const out = undoLast();
    expect(out).toContain('no existía');
    expect(out).toContain('2026-11-02 06:23');
    expect(out).not.toContain('UTC');
  });
});
