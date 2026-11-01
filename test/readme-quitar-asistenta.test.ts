import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Quitar Asistenta: si se borra la carpeta antes de `autostart uninstall`, las
// tareas de Windows (y el vigilante, cada 5 min) se quedan apuntando a nada. Y los
// datos viven fuera de la carpeta. La guía lo dice y coincide con el código.
// README.md está en inglés (Nico, 1 nov) y README.es.md en castellano: los dos.
const seccionDe = (fichero: string, titulo: string) => {
  const readme = readFileSync(fichero, 'utf8');
  const i = readme.indexOf(titulo);
  if (i < 0) return '';
  const fin = readme.indexOf('\n#', i + 5);
  return readme.slice(i, fin < 0 ? undefined : fin);
};

describe.each([
  {
    fichero: 'README.es.md',
    titulo: '## Quitar Asistenta del PC',
    borra: 'Borra la carpeta de Asistenta',
  },
  {
    fichero: 'README.md',
    titulo: '## Uninstalling Asistenta',
    borra: 'Delete the Asistenta folder',
  },
])('$fichero: quitar Asistenta del PC', ({ fichero, titulo, borra }) => {
  const seccion = seccionDe(fichero, titulo);

  it('tiene la sección', () => {
    expect(seccion).not.toBe('');
  });

  it('quita el arranque con Windows antes de borrar la carpeta', () => {
    const quitar = seccion.indexOf('autostart uninstall');
    const borrar = seccion.indexOf(borra);
    expect(quitar).toBeGreaterThan(0);
    expect(borrar).toBeGreaterThan(quitar);
  });

  it('nombra las tareas de Windows tal como las registra el código', () => {
    const ps1 = readFileSync('deploy/windows/install-all.ps1', 'utf8');
    const vig = readFileSync('src/autostart-watchdog.ts', 'utf8');
    const nombres = [
      ...[...ps1.matchAll(/Name='([a-z-]+)'/g)].map((m) => m[1]),
      ...[...vig.matchAll(/'(Asistenta-[a-z]+)'/g)].map((m) => m[1]),
    ];
    expect(nombres.length).toBeGreaterThanOrEqual(3);
    for (const n of new Set(nombres)) expect(seccion).toContain(`\`${n}\``);
  });

  it('dice dónde quedan los datos, la misma carpeta que usa Asistenta', () => {
    const paths = readFileSync('src/paths.ts', 'utf8');
    const m = paths.match(/join\(homedir\(\), ((?:'[^']+'(?:, )?)+)\)/);
    expect(m).not.toBeNull();
    const partes = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(seccion).toContain(`%USERPROFILE%\\${partes.join('\\')}`);
    expect(seccion).toContain('PA_STATE_DIR');
  });
});
