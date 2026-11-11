import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configurarAdjuntos, mirarAdjunto } from '../src/mail/adjuntos.js';

// bugs-35 (lead de bugs-34): con la «factura.pdf» en Documentos y otra en la Documentos de
// OneDrive (Windows mueve ahí Documentos/Escritorio), el aviso decía «hay 2 con ese nombre
// (Documentos, Documentos); dime la carpeta»: Nico no podía saber cuál era cuál.

let base: string;
let home: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bugs35-adj-'));
  home = join(base, 'home');
  const dirs = [
    join(home, 'Documentos', 'facturas'),
    join(home, 'OneDrive', 'Documentos', 'facturas'),
    join(home, 'Descargas'),
    join(base, 'estado', 'creados'),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, 'Documentos', 'factura.pdf'), 'a');
  writeFileSync(join(home, 'OneDrive', 'Documentos', 'factura.pdf'), 'b');
  writeFileSync(join(home, 'Documentos', 'facturas', 'enero.pdf'), 'c');
  writeFileSync(join(home, 'OneDrive', 'Documentos', 'facturas', 'enero.pdf'), 'd');
  writeFileSync(join(home, 'Documentos', 'notas.txt'), 'e');
  writeFileSync(join(home, 'Descargas', 'notas.txt'), 'f');
  configurarAdjuntos({
    creadosDir: join(base, 'estado', 'creados'),
    stateDir: join(base, 'estado'),
    roots: [
      join(home, 'Documentos'),
      join(home, 'Descargas'),
      join(home, 'OneDrive', 'Documentos'),
    ],
  });
});
afterEach(() => configurarAdjuntos(null));

const why = (ref: string): string => {
  const a = mirarAdjunto(ref);
  expect(a.ok).toBe(false);
  return a.ok ? '' : a.why;
};

describe('adjuntos con el mismo nombre: dice cuál es cuál (OneDrive)', () => {
  it('Documentos y la Documentos de OneDrive se distinguen', () => {
    const w = why('factura.pdf');
    expect(w).not.toContain('(Documentos, Documentos)');
    expect(w).toContain('OneDrive/Documentos');
    expect(w).toMatch(/\(Documentos, OneDrive\/Documentos\)|\(OneDrive\/Documentos, Documentos\)/);
  });

  it('con subcarpeta también: «Documentos/facturas/enero.pdf»', () => {
    const w = why('Documentos/facturas/enero.pdf');
    expect(w).not.toContain('(facturas, facturas)');
    expect(w).toContain('OneDrive/Documentos/facturas');
    expect(w).toContain('Documentos/facturas');
  });

  it('carpetas distintas siguen saliendo igual de cortas', () => {
    expect(why('notas.txt')).toMatch(/\((Documentos, Descargas|Descargas, Documentos)\)/);
  });
});
