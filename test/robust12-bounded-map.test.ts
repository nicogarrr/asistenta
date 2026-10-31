import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoundedMap } from '../src/bounded-map.js';

describe('mapa con tope', () => {
  it('se queda con las claves más nuevas', () => {
    const m = new BoundedMap<string, number>(3);
    for (let i = 0; i < 10; i++) m.set(`k${i}`, i);
    expect(m.size).toBe(3);
    expect([...m.keys()]).toEqual(['k7', 'k8', 'k9']);
  });

  it('volver a guardar una clave la hace nueva', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1).set('b', 2).set('a', 3).set('c', 4);
    expect([...m.entries()]).toEqual([
      ['a', 3],
      ['c', 4],
    ]);
  });

  it('el daemon no guarda mensaje→conversación sin límite', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/const messageThread = new Map</);
    expect(src).toMatch(/const messageThread = new BoundedMap</);
  });
});
