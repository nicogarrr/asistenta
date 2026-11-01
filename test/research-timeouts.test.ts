import { describe, expect, it } from 'vitest';
import { deepResearch } from '../src/research/deep-research.js';
import { bounded, mapLimit } from '../src/research/limits.js';
import { wideResearch } from '../src/research/wide-research.js';

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const hit = (n: number) => ({
  title: `Fuente ${n}`,
  url: `https://ejemplo${n}.es/p`,
  snippet: 'precio luz',
});
const page = 'El precio medio de la luz en octubre fue de 120 euros por megavatio hora segun REE.';

describe('/investiga con una web colgada', () => {
  it('una lectura que nunca responde no bloquea el informe', async () => {
    const report = await deepResearch('precio medio luz octubre', {
      search: async () => [hit(1), hit(2), hit(3)],
      fetch: async (url) => (url.includes('ejemplo2') ? never<string>() : page),
      callTimeoutMs: 50,
      maxQuestions: 1,
    });
    expect(report.sources.map((s) => s.url)).toEqual([
      'https://ejemplo1.es/p',
      'https://ejemplo3.es/p',
    ]);
    expect(report.sources.map((s) => s.id)).toEqual([1, 2]);
    expect(report.unverified.join(' ')).toContain('ejemplo2.es');
  }, 3000);

  it('una búsqueda que nunca responde no deja /investiga colgado', async () => {
    await expect(
      deepResearch('precio medio luz octubre', {
        search: () => never(),
        fetch: async () => page,
        callTimeoutMs: 50,
        maxQuestions: 1,
      }),
    ).rejects.toThrow(/ninguna fuente/);
  }, 3000);

  it('las lecturas van en paralelo (no una detrás de otra)', async () => {
    let active = 0;
    let peak = 0;
    await deepResearch('precio medio luz octubre', {
      search: async () => [hit(1), hit(2), hit(3), hit(4)],
      fetch: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return page;
      },
      maxQuestions: 1,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  }, 3000);

  it('amplio: un elemento con la web colgada no bloquea la tabla', async () => {
    const report = await wideResearch('precio luz', ['octubre', 'noviembre'], {
      search: async (q) => (q.startsWith('noviembre') ? never() : [hit(1)]),
      fetch: async () => page,
      callTimeoutMs: 50,
    });
    expect(JSON.stringify(report)).toContain('octubre');
  }, 3000);
});

describe('limits', () => {
  it('bounded rechaza al pasar el tope y deja pasar lo rápido', async () => {
    await expect(bounded(() => never(), 20)).rejects.toThrow(/sin respuesta/);
    await expect(bounded(async () => 7, 20)).resolves.toBe(7);
  });
  it('mapLimit conserva el orden', async () => {
    const out = await mapLimit([30, 1, 10], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });
});
