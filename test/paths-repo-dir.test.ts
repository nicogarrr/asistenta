import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_DIR, repoDirFrom } from '../src/paths.js';

describe('REPO_DIR con espacios o tildes en la ruta', () => {
  it('decodifica la URL del módulo en vez de dejar %20 / %C3%A1', () => {
    // resolve (no join): en Windows '/tmp' es relativo a la unidad y fileURLToPath devuelve «D:\tmp\…»;
    // resolve da la misma ruta absoluta que devuelve repoDirFrom en cada sistema.
    const root = resolve('/tmp', 'Mis proyectos', 'Nicolás', 'asistenta');
    const url = pathToFileURL(join(root, 'dist', 'paths.js')).href;
    expect(url).toContain('%20');
    expect(repoDirFrom(url)).toBe(root);
  });

  it('el REPO_DIR real apunta a la carpeta que tiene package.json', async () => {
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(REPO_DIR, 'package.json'))).toBe(true);
  });
});
