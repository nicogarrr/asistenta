import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configurarAdjuntos, mirarAdjunto, raicesPorDefecto } from '../src/mail/adjuntos.js';

// bugs-34: la carpeta del programa era una raíz de adjuntos (`process.cwd()` en
// raicesPorDefecto): «adjunta C:\…\asistenta\config\tv.json» salía por correo. Y si el
// repo vive en Documentos, sus ficheros se podían adjuntar igual. Ahora solo
// Documentos/Escritorio/Descargas y lo que Asistenta hizo; el programa, nunca.

let base: string;
let home: string;
let docs: string;
let repoEnDocs: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bugs34-adj-'));
  home = join(base, 'home');
  docs = join(home, 'Documentos');
  repoEnDocs = join(docs, 'asistenta');
  for (const d of [join(repoEnDocs, 'config'), join(base, 'estado', 'creados')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(repoEnDocs, 'config', 'tv.json'), '{"clave":"x"}');
  writeFileSync(join(docs, 'tesis.pdf'), Buffer.alloc(4000, 2));
});
afterEach(() => configurarAdjuntos(null));

describe('adjuntos: solo las carpetas del usuario, nunca la del programa', () => {
  it('las raíces por defecto no incluyen la carpeta de trabajo', () => {
    const roots = raicesPorDefecto(home);
    expect(roots).not.toContain(process.cwd());
    expect(roots).toContain(join(home, 'Documentos'));
    expect(roots.every((r) => r.startsWith(home))).toBe(true);
  });

  it('un fichero del repo dentro de Documentos no se adjunta; lo demás de Documentos sí', () => {
    configurarAdjuntos({
      creadosDir: join(base, 'estado', 'creados'),
      stateDir: join(base, 'estado'),
      roots: [docs],
      excluir: [repoEnDocs],
    });
    const a = mirarAdjunto(join(repoEnDocs, 'config', 'tv.json'));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.why).toMatch(/programa/);
    expect(mirarAdjunto('Documentos/asistenta/config/tv.json').ok).toBe(false);
    expect(mirarAdjunto(join(docs, 'tesis.pdf'))).toMatchObject({ ok: true });
  });

  it('una carpeta excluida que contiene las raíces (arrancado desde el home) no bloquea todo', () => {
    configurarAdjuntos({
      creadosDir: join(base, 'estado', 'creados'),
      stateDir: join(base, 'estado'),
      roots: [docs],
      excluir: [home],
    });
    expect(mirarAdjunto(join(docs, 'tesis.pdf'))).toMatchObject({ ok: true });
  });
});
