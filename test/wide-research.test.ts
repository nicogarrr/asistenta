import { describe, expect, it } from 'vitest';
import {
  mapLimit,
  parseWideArgs,
  renderWideReport,
  WIDE_MAX_ITEMS,
  type WideDeps,
  wideReportCsv,
  wideResearch,
  wideResearchEnabled,
} from '../src/research/wide-research.js';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fakeDeps(over: Partial<WideDeps> = {}): WideDeps & { maxInFlight: () => number } {
  let inFlight = 0;
  let max = 0;
  return {
    async search(query) {
      inFlight++;
      max = Math.max(max, inFlight);
      await tick();
      inFlight--;
      const item = query.split(' ')[0];
      if (item === 'roto') throw new Error('boom');
      return [{ title: `Pagina ${item}`, url: `https://ej.example/${item}`, snippet: '' }];
    },
    async fetch(url) {
      const item = url.split('/').pop();
      return `Ficha tecnica. El ${item} tiene garantia de dos anos y precio de 900 euros en tienda.`;
    },
    maxInFlight: () => max,
    ...over,
  };
}

describe('parseWideArgs', () => {
  it('separa pregunta y lista, quita viñetas y duplicados', () => {
    expect(parseWideArgs('precio y garantia | iPhone, Pixel ; - Galaxy\n2) pixel')).toEqual({
      question: 'precio y garantia',
      items: ['iPhone', 'Pixel', 'Galaxy'],
    });
  });
  it('sin barra o sin lista → null', () => {
    expect(parseWideArgs('precio del iPhone')).toBeNull();
    expect(parseWideArgs('precio | , ,')).toBeNull();
    expect(parseWideArgs(' | a, b')).toBeNull();
  });
});

describe('wideResearch', () => {
  it('5 elementos → 5 filas en orden, nunca más de 3 a la vez', async () => {
    const deps = fakeDeps();
    const items = ['a1', 'b2', 'c3', 'd4', 'e5'];
    const r = await wideResearch('garantia precio', items, deps);
    expect(r.rows.map((x) => x.item)).toEqual(items);
    expect(r.rows.every((x) => x.ok)).toBe(true);
    expect(deps.maxInFlight()).toBe(3);
    expect(r.sources).toHaveLength(5);
    // citas globales: la fila 4 cita la fuente 4
    expect(r.rows[3]?.cell).toContain('[4]');
    expect(r.sources[3]?.url).toBe('https://ej.example/d4');
  });

  it('un elemento que falla queda «sin datos» sin abortar el resto', async () => {
    const r = await wideResearch('garantia', ['a1', 'roto', 'c3'], fakeDeps());
    expect(r.rows.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r.rows[1]?.cell).toMatch(/^sin datos/);
    expect(r.rows[2]?.cell).toContain('[2]');
  });

  it('presupuesto agotado → para y lo dice', async () => {
    const r = await wideResearch(
      'garantia',
      ['a1', 'b2', 'c3', 'd4'],
      fakeDeps({ maxOps: 4, concurrency: 1 }),
    );
    expect(r.rows.slice(0, 2).every((x) => x.ok)).toBe(true);
    expect(r.rows.slice(2).map((x) => x.cell)).toEqual([
      'sin datos (presupuesto agotado)',
      'sin datos (presupuesto agotado)',
    ]);
    expect(r.budgetExhausted).toBe(true);
    expect(renderWideReport(r)).toContain('Presupuesto agotado');
  });

  it('con modelo: celda del modelo con cita renumerada; cita inventada se descarta', async () => {
    let calls = 0;
    const r = await wideResearch(
      'garantia',
      ['a1', 'b2'],
      fakeDeps({
        concurrency: 1,
        llm: async (_s, user) => {
          calls++;
          expect(user).toContain('<fuente n="1"');
          return 'Dos años de garantía [1] [7].';
        },
      }),
    );
    expect(calls).toBe(2);
    expect(r.usedLlm).toBe(true);
    expect(r.rows[1]?.cell).toBe('Dos años de garantía [2] .');
  });

  it('modelo que dice «sin datos» → fila sin datos y sin fuentes', async () => {
    const r = await wideResearch('garantia', ['a1'], fakeDeps({ llm: async () => 'sin datos' }));
    expect(r.rows[0]).toMatchObject({ ok: false, cell: 'sin datos' });
    expect(r.sources).toHaveLength(0);
  });

  it('rechaza listas demasiado largas y preguntas vacías', async () => {
    const many = Array.from({ length: WIDE_MAX_ITEMS + 1 }, (_, i) => `x${i}`);
    await expect(wideResearch('q', many, fakeDeps())).rejects.toThrow(/Como mucho/);
    await expect(wideResearch('  ', ['a'], fakeDeps())).rejects.toThrow(/Falta la pregunta/);
  });
});

describe('salida', () => {
  it('tabla Markdown sin romper columnas y CSV escapado', async () => {
    const r = await wideResearch('garantia', ['a1'], fakeDeps());
    r.rows[0] = { item: 'a|b', cell: 'di "hola"', ok: true };
    const txt = renderWideReport(r);
    expect(txt).toContain('| Elemento | Resultado |');
    expect(txt).toContain('| a/b | di "hola" |');
    expect(wideReportCsv(r)).toBe('elemento,resultado\n"a|b","di ""hola"""');
  });

  it('mapLimit mantiene el orden aunque terminen desordenados', async () => {
    const out = await mapLimit([30, 1, 10], 3, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 1, 10]);
  });
});

describe('interruptor', () => {
  it('apagado por defecto; solo PA_INVESTIGA_AMPLIO=1 lo activa', () => {
    expect(wideResearchEnabled({})).toBe(false);
    expect(wideResearchEnabled({ PA_INVESTIGA_AMPLIO: 'true' })).toBe(false);
    expect(wideResearchEnabled({ PA_INVESTIGA_AMPLIO: '1' })).toBe(true);
  });
});
