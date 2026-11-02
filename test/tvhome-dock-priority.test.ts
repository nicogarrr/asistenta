/**
 * DOCK_PRIORITY (los primeros tiles del dock del Home de Nico) tiene que usar
 * ids del catalogo APPS: un id que no existe no falla, pero silenciosamente NO
 * prioriza (bug real 2026-11-02: «com.nuvio.tv»/«com.movistarplus.es.iptv»
 * ya no eran los ids instalados y el foco inicial caia en otro tile).
 */
import { describe, expect, it } from 'vitest';
import {
  APPS,
  DOCK_PRIORITY,
  sortDockByPriority,
  type AppItem as Tile,
} from '../tools/tv-home/src/lib/apps.js';

const CATALOGO: Tile[] = Object.values(APPS).flat();

describe('dock del Home de Nico', () => {
  it('cada id prioritario existe en el catalogo', () => {
    const ids = new Set(CATALOGO.map((a: Tile) => a.id));
    for (const id of DOCK_PRIORITY) {
      expect(ids.has(id), `${id} no esta en el catalogo APPS`).toBe(true);
    }
  });

  it('sin orden guardado el dock empieza por Nuvio, Netflix y Movistar Plus+', () => {
    const sorted = sortDockByPriority(CATALOGO);
    expect(sorted.slice(0, 3).map((a: Tile) => a.id)).toEqual([
      'space.nuvio.webos',
      'netflix',
      'com.telefonica.app.nux',
    ]);
  });

  it('el resto conserva su orden relativo (sort estable)', () => {
    const sorted = sortDockByPriority(CATALOGO);
    const resto = sorted.filter((a: Tile) => !DOCK_PRIORITY.includes(a.id));
    const esperado = CATALOGO.filter((a: Tile) => !DOCK_PRIORITY.includes(a.id));
    expect(resto.map((a: Tile) => a.id)).toEqual(esperado.map((a: Tile) => a.id));
  });
});
