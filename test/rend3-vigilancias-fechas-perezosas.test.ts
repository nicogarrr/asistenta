import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageWatch, WatchSummary } from '../src/watch/pages.js';

/**
 * Los formateadores de fecha de las vigilancias se crean al primer uso, no al
 * importar (el primer `Intl.DateTimeFormat` carga ICU y lo pagaba cada `pa …`).
 * Las fichas tienen que salir exactamente igual: estos textos son los del main
 * anterior al cambio (invierno, verano y los dos cambios de hora).
 */
const base: PageWatch = {
  id: 'w1',
  scope: 'chat:1',
  url: 'https://tienda.example/p/1',
  label: 'Cafetera',
  lastValue: '49,90 €',
  lastCheckedAt: 0,
  failures: 0,
  createdAt: 0,
  active: true,
  keyword: '',
  targetCents: 4500,
  dropPct: 10,
  lastAlertAt: 0,
  lastAlertCents: null,
  mutedUntil: 0,
};
const cases: [PageWatch, WatchSummary][] = [
  [
    { ...base },
    {
      readings: 12,
      firstAt: Date.UTC(2026, 0, 5, 23, 30),
      lastAt: Date.UTC(2026, 6, 14, 21, 5),
      lastCents: 4990,
      lastInStock: true,
      minCents: 4500,
      medianCents: 4990,
      maxCents: 5990,
      sparkline: '▁▂▃',
    },
  ],
  [
    { ...base, mutedUntil: Date.UTC(2026, 9, 25, 0, 59), targetCents: null },
    {
      readings: 1,
      firstAt: Date.UTC(2026, 9, 25, 1, 0),
      lastAt: Date.UTC(2026, 9, 25, 1, 0),
      lastCents: 100,
      lastInStock: false,
      minCents: 100,
      medianCents: 100,
      maxCents: 100,
      sparkline: '',
    },
  ],
  [
    { ...base, mutedUntil: Date.UTC(2026, 2, 29, 1, 15), dropPct: null },
    {
      readings: 3,
      firstAt: Date.UTC(2026, 2, 29, 0, 59),
      lastAt: Date.UTC(2026, 11, 31, 23, 0),
      lastCents: 123456,
      lastInStock: null,
      minCents: 99,
      medianCents: 500,
      maxCents: 123456,
      sparkline: '▁█',
    },
  ],
];

const ANTES: string[] = [
  'Cafetera (id w1)\nhttps://tienda.example/p/1\nÚltimo: 49,90 € (14/7, 23:05, en stock)\nHistórico: 12 lecturas desde 6/1/2026 · mín 45,00 € · mediana 49,90 € · máx 59,90 €\n▁▂▃\nObjetivo: te aviso si baja de 45,00 €.\nTe aviso si baja un 10 % o más.',
  'Cafetera (id w1)\nhttps://tienda.example/p/1\nÚltimo: 1,00 € (25/10, 02:00, consta agotado)\nHistórico: 1 lecturas desde 25/10/2026 · mín 1,00 € · mediana 1,00 € · máx 1,00 €\nTe aviso si baja un 10 % o más.\n🔕 Silenciada hasta 25/10, 02:59. Si quieres que vuelva a avisarte antes, dime «avísame otra vez».',
  'Cafetera (id w1)\nhttps://tienda.example/p/1\nÚltimo: 1.234,56 € (1/1, 00:00)\nHistórico: 3 lecturas desde 29/3/2026 · mín 0,99 € · mediana 5,00 € · máx 1.234,56 €\n▁█\nObjetivo: te aviso si baja de 45,00 €.',
];

const RealDTF = Intl.DateTimeFormat;
afterEach(() => {
  Intl.DateTimeFormat = RealDTF;
  vi.resetModules();
});

describe('vigilancias: formateadores de fecha perezosos, mismas fichas', () => {
  it('describeWatch da exactamente lo mismo que antes del cambio', async () => {
    const { describeWatch } = await import('../src/watch/pages.js');
    const now = Date.UTC(2026, 9, 1);
    expect(cases.map(([w, s]) => describeWatch(w, s, now))).toEqual(ANTES);
  });

  it('importar el módulo no crea ningún formateador; el primer uso los crea una sola vez', async () => {
    vi.resetModules();
    let creados = 0;
    Intl.DateTimeFormat = new Proxy(RealDTF, {
      construct(target, args, newTarget) {
        if (args[1]?.timeZone === 'Europe/Madrid') creados++;
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, thisArg, args) {
        if (args[1]?.timeZone === 'Europe/Madrid') creados++;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const { describeWatch } = await import('../src/watch/pages.js');
    expect(creados).toBe(0);
    const now = Date.UTC(2026, 9, 1);
    const fichas = () => cases.map(([w, s]) => describeWatch(w, s, now));
    expect(fichas()).toEqual(ANTES);
    const tras = creados;
    expect(tras).toBeGreaterThan(0);
    expect(fichas()).toEqual(ANTES);
    expect(creados).toBe(tras);
  });
});
