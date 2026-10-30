import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { vigilanciasErrorNote } from '../src/cli.js';

/** /vigilancias dice QUÉ lista no ha podido leer, no solo cuántas. */
describe('/vigilancias: qué lista falló', () => {
  it('sin errores no añade nada', () => {
    expect(vigilanciasErrorNote([])).toBe('');
  });

  it('nombra cada lista que falló, sin el detalle (rutas) del error', () => {
    const note = vigilanciasErrorNote([
      'páginas: SQLITE_BUSY: database is locked',
      'pricewatch.json: ENOENT C:\\Users\\nico\\pricewatch.json',
    ]);
    expect(note).toContain('páginas vigiladas');
    expect(note).toContain('vigilante de precios (pricewatch.json)');
    expect(note).not.toContain('C:\\Users');
    expect(note).not.toContain('SQLITE_BUSY');
    expect(note).toContain('pa vigilancias');
  });

  it('ojo y rutinas con su nombre; una lista desconocida sale por su nombre; sin repetir', () => {
    const note = vigilanciasErrorNote(['ojo: x', 'rutinas: y', 'rutinas: z', 'nueva: w']);
    expect(note).toContain('ojo de águila');
    expect(note.match(/rutinas/g)?.length).toBe(1);
    expect(note).toContain('nueva');
  });

  it('el comando /vigilancias usa la nota con nombres', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('const note = vigilanciasErrorNote(errors);');
    expect(cli).not.toContain('(no he podido leer: $' + '{errors.length})');
  });
});
