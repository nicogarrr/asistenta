import { describe, expect, it } from 'vitest';
import { temasDelPerfil } from '../src/noticias-temas.js';

/**
 * «Tus temas» solo sacaba del perfil el equipo («Soy del Sporting»). Lo que Nico cuenta que
 * sigue («sigo la F1», «soy fan de Rosalía») también es un tema para los titulares.
 */
describe('temas sacados del perfil', () => {
  it('equipo y aficiones, sin repetir', () => {
    expect(
      temasDelPerfil([
        '[dicho] Soy del Sporting',
        '[dicho] Sigo la F1.',
        '[auto] soy muy aficionado al ciclismo',
        '[dicho] Soy fan de Rosalía',
        '[importado] Me encanta la Fórmula 1',
        '[dicho] sigo la f1',
      ]),
    ).toEqual(['Sporting', 'F1', 'ciclismo', 'Rosalía', 'Fórmula 1']);
  });

  it('lo que no es una afición no cuenta', () => {
    expect(
      temasDelPerfil([
        '[dicho] Soy de Gijón',
        '[dicho] Me encanta comer pizza',
        '[dicho] Me encanta el chocolate',
        '[dicho] Mi hermana sigue en Madrid',
        '[dicho] Sigo viviendo en Gijón con mi pareja y los dos gatos de casa',
      ]),
    ).toEqual([]);
  });
});
