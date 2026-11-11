import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configurarAdjuntos, mirarAdjunto } from '../src/mail/adjuntos.js';

// bugs-33 (11 nov 2026): «adjunta la factura.pdf de Descargas» no funcionaba. El modelo
// pasaba «Descargas/factura.pdf» o «factura.pdf» (no sabe la ruta entera del usuario en
// Windows, C:\Users\<nombre>\…) y el adjunto salía «no lo encuentro entre lo que te he
// hecho; dime la ruta». Ahora se busca en Documentos/Escritorio/Descargas con las mismas
// reglas (nada oculto, ni claves), y si hay dos con el mismo nombre lo pregunta.

let base: string;
let docs: string;
let descargas: string;
let repo: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bugs33-adj-'));
  const home = join(base, 'home');
  docs = join(home, 'Documentos');
  descargas = join(home, 'Descargas');
  repo = join(base, 'asistenta');
  for (const d of [docs, descargas, repo, join(base, 'estado', 'creados')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(descargas, 'factura.pdf'), Buffer.alloc(3000, 1));
  writeFileSync(join(docs, 'tesis.pdf'), Buffer.alloc(4000, 2));
  writeFileSync(join(docs, 'notas.txt'), 'a');
  writeFileSync(join(descargas, 'notas.txt'), 'b');
  writeFileSync(join(docs, 'claves.pem'), 'secreto');
  writeFileSync(join(repo, 'README.md'), 'repo');
  configurarAdjuntos({
    creadosDir: join(base, 'estado', 'creados'),
    stateDir: join(base, 'estado'),
    roots: [repo, docs, descargas],
  });
});
afterEach(() => configurarAdjuntos(null));

describe('correo: adjuntos por carpeta y nombre, sin la ruta entera', () => {
  it('«Descargas/factura.pdf» se encuentra en la carpeta Descargas', () => {
    expect(mirarAdjunto('Descargas/factura.pdf')).toMatchObject({
      ok: true,
      name: 'factura.pdf',
      path: join(descargas, 'factura.pdf'),
    });
    expect(mirarAdjunto('descargas\\factura.pdf')).toMatchObject({ ok: true });
  });

  it('un nombre a secas se busca en Documentos/Escritorio/Descargas', () => {
    expect(mirarAdjunto('tesis.pdf')).toMatchObject({ ok: true, path: join(docs, 'tesis.pdf') });
  });

  it('si hay dos con el mismo nombre, no elige: dice dónde están', () => {
    const a = mirarAdjunto('notas.txt');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.why).toMatch(/Documentos.*Descargas|Descargas.*Documentos/);
  });

  it('las mismas reglas: ni claves, ni salir de la carpeta, ni la carpeta del programa', () => {
    expect(mirarAdjunto('claves.pem')).toMatchObject({ ok: false });
    expect(mirarAdjunto('Documentos/../../asistenta/README.md')).toMatchObject({ ok: false });
    expect(mirarAdjunto('README.md')).toMatchObject({ ok: false });
    expect(mirarAdjunto('no-existe.pdf')).toMatchObject({ ok: false });
  });
});
