import { describe, expect, it } from 'vitest';
import { parseCommandAdd, splitArgv } from '../src/command-routine.js';

describe('rutinas de comando: rutas de Windows dichas desde el móvil (bugs14)', () => {
  it('las comillas tipográficas del móvil (“ ” „) agrupan igual que "', () => {
    expect(splitArgv('node “C:\\Mis scripts\\saldo.js”')).toEqual([
      'node',
      'C:\\Mis scripts\\saldo.js',
    ]);
    expect(splitArgv('„C:\\Archivos de programa\\app.exe” --ya')).toEqual([
      'C:\\Archivos de programa\\app.exe',
      '--ya',
    ]);
    expect(splitArgv('node "C:\\Mis scripts\\x.js”')).toEqual(['node', 'C:\\Mis scripts\\x.js']);
    expect(splitArgv('node “sin cerrar')).toBeNull();
  });

  it('un apóstrofo dentro de una palabra es parte de la ruta, no una comilla', () => {
    expect(splitArgv("node C:\\Users\\O'Brien\\a.js")).toEqual([
      'node',
      "C:\\Users\\O'Brien\\a.js",
    ]);
    expect(splitArgv("python D:\\l'Hospitalet\\b.py 'a b'")).toEqual([
      'python',
      "D:\\l'Hospitalet\\b.py",
      'a b',
    ]);
  });

  it('dicho normal con comillas del móvil y tildes: el programa llega entero', () => {
    const r = parseCommandAdd(
      'cada día a las 8 ejecuta node “C:\\Users\\José\\Mis scripts\\saldo.js”',
      () => ({ ok: true }),
      () => '0 8 * * *',
    );
    expect(r.ok && r.value.argv).toEqual(['node', 'C:\\Users\\José\\Mis scripts\\saldo.js']);
  });
});
