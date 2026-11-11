import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreadosStore } from '../src/creados.js';

// bugs-35 (lead de bugs-34, el mismo caso que #2311): en Windows la hora de modificación
// avanza a saltos (~15 ms), así que dos archivos guardados seguidos pueden tener la misma.
// Entonces /biblioteca (y la poda) desempataban por el texto del id, y
// «…-120000-2-grafica.png» (la nueva) iba DETRÁS de «…-120000-grafica.png» (la vieja):
// la lista salía al revés y «📤 1» mandaba la gráfica antigua.

let d: string;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'bugs35-creados-'));
});
afterEach(() => rmSync(d, { recursive: true, force: true }));

const T = new Date(2026, 10, 11, 12, 0, 0, 0).getTime();

function guardarMismaHora(store: CreadosStore, nombres: string[]): string[] {
  const ids = nombres.map((n, i) => store.guardar(Buffer.from(`v${i}`), n) ?? '');
  // Misma hora de modificación para todos, como en Windows al guardarlos seguidos.
  for (const id of ids) utimesSync(join(d, id), T / 1000, T / 1000);
  return ids;
}

describe('creados: el más nuevo primero aunque compartan segundo y hora de modificación', () => {
  it('«grafica.png» dos veces en el mismo segundo: la segunda va primero', () => {
    const store = new CreadosStore(d, () => T);
    const [vieja, nueva] = guardarMismaHora(store, ['grafica.png', 'grafica.png']);
    expect(nueva).toMatch(/-2-grafica\.png$/);
    expect(store.lista().map((c) => c.id)).toEqual([nueva, vieja]);
  });

  it('con 10 o más en el mismo segundo, «-10-» es más nuevo que «-9-»', () => {
    const store = new CreadosStore(d, () => T);
    const ids = guardarMismaHora(store, Array(11).fill('grafica.png'));
    expect(store.lista().map((c) => c.id)).toEqual([...ids].reverse());
  });
});
