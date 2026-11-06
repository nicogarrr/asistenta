import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlanPrecios } from '../src/precios/planificador.js';
import { textoResumenDiario, VigilantePrecios } from '../src/precios/vigilante.js';

const MIN = 60_000;
const HORA = 60 * MIN;
const nunca = () => new Promise<never>(() => {});

describe('precios: sigue solo tras suspender el portátil', () => {
  it('un barrido colgado durante la suspensión no frena el plan: al despertar vuelve a barrir', async () => {
    let now = 0;
    const llamadas: number[] = [];
    const p = new PlanPrecios({
      barrer: (rapido) => {
        llamadas.push(now);
        // El primero se queda colgado (Chrome dormido); los demás acaban.
        return llamadas.length === 1 ? nunca() : Promise.resolve(rapido);
      },
      cadaMin: 30,
      rapidoMin: 0,
      silencio: () => false,
      now: () => now,
    });
    now = 2 * MIN;
    void p.tick();
    now = 10 * MIN;
    expect(await p.tick()).toBeNull(); // sigue en curso, sin duplicar
    now = 3 * HORA; // el portátil despierta tres horas después
    expect(await p.tick()).toBe('normal');
    expect(llamadas).toEqual([2 * MIN, 3 * HORA]);
  });

  it('VigilantePrecios: un barrido colgado más de 30 min no bloquea el siguiente', async () => {
    let now = 1_000;
    let colgar = true;
    const v = new VigilantePrecios({
      archivo: join(mkdtempSync(join(tmpdir(), 'pr3-')), 'p.json'),
      categorias: [{ id: 'x', nombre: 'x', urls: ['https://www.amazon.es/s?k=x'] }],
      leerListado: () =>
        colgar ? nunca() : Promise.resolve({ status: 200, html: '<html></html>' }),
      leerFicha: async () => ({ status: 200, html: '' }),
      avisar: async () => {},
      now: () => now,
      esperar: async () => {},
    });
    void v.barrer();
    colgar = false;
    expect(await v.barrer()).toBeNull();
    now += 31 * MIN;
    expect(await v.barrer()).not.toBeNull();
  });
});

describe('precios: resumen diario de las 21:00', () => {
  it('texto de una línea', () => {
    expect(
      textoResumenDiario(
        { dia: '2026-11-06', paginas: 412, avisos: 0, mejor: { pct: 64, titulo: 'Sony WH-CH520' } },
        '2026-11-06',
      ),
    ).toBe('Precios hoy: 412 páginas, mejor descuento 64 % (Sony WH-CH520), 0 errores de precio');
    expect(textoResumenDiario(undefined, '2026-11-06')).toBe(
      'Precios hoy: 0 páginas, sin descuentos a la vista, 0 errores de precio',
    );
  });

  it('sale una vez al día desde las 21:00 (Madrid), con lo barrido hoy', async () => {
    let now = Date.parse('2026-11-06T10:00:00Z'); // 11:00 en Madrid
    const enviados: string[] = [];
    // Forma real de un resultado de búsqueda con tachado (como en precios-amazon.test.ts).
    const html =
      '<div role="listitem" data-asin="B0TEST0001" data-component-type="s-search-result" class="sg-col-4-of-24">' +
      '<h2 aria-label="Sony WH-CH520 Auriculares" class="a-size-base-plus"><span>Sony WH-CH520 Auriculares</span></h2>' +
      '<a class="a-link-normal" href="/x/dp/B0TEST0001/"><span class="a-price" data-a-size="xl" data-a-color="base"><span class="a-offscreen">20,00 €</span><span aria-hidden="true">x</span></span></a>' +
      '<div class="a-section aok-inline-block"><span class="a-size-base a-color-secondary">Recomendado: <span class="a-price a-text-price" data-a-size="b" data-a-strike="true" data-a-color="secondary"><span class="a-offscreen">50,00 €</span><span aria-hidden="true">x</span></span></span></div>' +
      '</div>';
    const v = new VigilantePrecios({
      archivo: join(mkdtempSync(join(tmpdir(), 'pr3-')), 'p.json'),
      categorias: [{ id: 'x', nombre: 'x', urls: ['https://www.amazon.es/s?k=x'] }],
      leerListado: async () => ({ status: 200, html }),
      leerFicha: async () => ({ status: 200, html: '' }),
      avisar: async () => {},
      now: () => now,
      esperar: async () => {},
      tz: 'Europe/Madrid',
    });
    await v.barrer();
    const enviar = async (t: string) => void enviados.push(t);
    expect(await v.resumenDiario(enviar)).toBe(false); // aún no son las 21:00
    now = Date.parse('2026-11-06T20:00:00Z'); // 21:00 en Madrid
    expect(await v.resumenDiario(enviar)).toBe(true);
    expect(await v.resumenDiario(enviar)).toBe(false); // una vez al día
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatch(/^Precios hoy: 1 página, mejor descuento 60 % \(Sony WH-CH520/);
    now = Date.parse('2026-11-07T20:05:00Z');
    expect(await v.resumenDiario(enviar)).toBe(true);
    expect(enviados[1]).toBe(
      'Precios hoy: 0 páginas, sin descuentos a la vista, 0 errores de precio',
    );
  });
});
