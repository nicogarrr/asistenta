import { describe, expect, it } from 'vitest';
import { scanMoney } from '../src/ojo-charges.js';
import { findScreenFindings } from '../src/ojo-screen.js';
import { extractPriceTexts, parsePriceToCents } from '../src/tools/checkout.js';
import { extractPrice, parseAmount } from '../src/watch/pages.js';
import { parseEuroCents, parseMachinePrice } from '../src/watch/pricewatch.js';

// Caracterización (vc7): congela lo que devuelve HOY cada lector de importes, con las
// mismas entradas, antes de mover ninguno a src/money.ts. Las políticas difieren a
// propósito (p. ej. el espacio normal como separador de miles); mover un lector no
// puede cambiar ni una fila de estas tablas.

const show = (s: string): string =>
  s
    .replace(/\u00a0/g, '<nbsp>')
    .replace(/\u202f/g, '<nnbsp>')
    .replace(/\u2009/g, '<thin>');

const TEXTS = [
  '1.299,00 €',
  '1299,00 €',
  '1 299,00 €',
  '1\u00a0299,00 €',
  '1\u202f299,00 €',
  '1\u2009299,00 €',
  '€ 1 299,00',
  '€ 1\u00a0299,00',
  '€1.299,00',
  'EUR 12 345,50',
  'EUR 12,50.',
  '12,5 €',
  '12,50€',
  '100 €',
  '100 euros',
  '1,459 €',
  '1.459 €',
  '450.00 EUR',
  '1000€',
  'talla 42 199 €',
  'x2 299,00 €',
  '-12,00 €',
  '(12,00 €)',
  '12,00 €-',
  '$12.00',
  '£5',
  '1.299,999 €',
  '12.345.678,00 €',
  '0,00 €',
  '99,9 EUR',
  'precio: 1.234,56 EUR envío 4,99 €',
];

const RAWS = [
  '1.234,56',
  '45,20',
  '300',
  '1 299,00',
  '1\u00a0299,00',
  '1,459',
  '1.459',
  '12,5',
  '1.299,999',
  'abc',
  '',
  '12.34',
  '1,234.56',
  '0012',
  '1299.99',
];

describe('lectores de importes: salida actual congelada', () => {
  it('textos con divisa', () => {
    const rows = TEXTS.map((t) => {
      const money = scanMoney(t);
      return [
        show(t),
        `pricewatch=${parseEuroCents(t)}`,
        `pages=${extractPrice(t) === null ? 'null' : show(extractPrice(t) ?? '')}`,
        `charges=${money.bad ? 'bad' : 'ok'}:${money.cents.join('+')}`,
        `checkout=${extractPriceTexts(t)
          .map((p) => `${p.raw}${p.symbol}`)
          .join('+')}`,
        `screen=${findScreenFindings([`Pago pendiente: ${t}`]).length > 0}`,
      ].join(' | ');
    });
    expect(rows).toMatchInlineSnapshot(`
      [
        "1.299,00 € | pricewatch=129900 | pages=1299,00 € | charges=ok:129900 | checkout=1.299,00€ | screen=true",
        "1299,00 € | pricewatch=129900 | pages=1299,00 € | charges=ok:129900 | checkout=1299,00€ | screen=true",
        "1 299,00 € | pricewatch=129900 | pages=null | charges=ok: | checkout=1299,00€ | screen=true",
        "1<nbsp>299,00 € | pricewatch=129900 | pages=1299,00 € | charges=ok:129900 | checkout=1299,00€ | screen=true",
        "1<nnbsp>299,00 € | pricewatch=129900 | pages=1299,00 € | charges=ok:129900 | checkout=1299,00€ | screen=true",
        "1<thin>299,00 € | pricewatch=129900 | pages=1299,00 € | charges=ok:129900 | checkout=1299,00€ | screen=true",
        "€ 1 299,00 | pricewatch=null | pages=1,00 € | charges=bad: | checkout=1299,00€ | screen=false",
        "€ 1<nbsp>299,00 | pricewatch=null | pages=1299,00 € | charges=ok:129900 | checkout=1299,00€ | screen=false",
        "€1.299,00 | pricewatch=null | pages=1299,00 € | charges=ok:129900 | checkout=1.299,00€ | screen=true",
        "EUR 12 345,50 | pricewatch=null | pages=12,00 € | charges=bad: | checkout=12345,50€ | screen=false",
        "EUR 12,50. | pricewatch=null | pages=12,50 € | charges=ok:1250 | checkout=12,50€ | screen=true",
        "12,5 € | pricewatch=1250 | pages=12,50 € | charges=bad: | checkout= | screen=true",
        "12,50€ | pricewatch=1250 | pages=12,50 € | charges=ok:1250 | checkout=12,50€ | screen=true",
        "100 € | pricewatch=10000 | pages=100,00 € | charges=ok:10000 | checkout=100€ | screen=true",
        "100 euros | pricewatch=null | pages=null | charges=ok:10000 | checkout= | screen=true",
        "1,459 € | pricewatch=null | pages=1,459 € | charges=bad: | checkout= | screen=true",
        "1.459 € | pricewatch=145900 | pages=1459,00 € | charges=ok:145900 | checkout=1.459€ | screen=true",
        "450.00 EUR | pricewatch=null | pages=450,00 € | charges=ok:45000 | checkout= | screen=false",
        "1000€ | pricewatch=100000 | pages=1000,00 € | charges=ok:100000 | checkout=1000€ | screen=true",
        "talla 42 199 € | pricewatch=4219900 | pages=null | charges=ok: | checkout=42199€ | screen=true",
        "x2 299,00 € | pricewatch=229900 | pages=null | charges=ok: | checkout=2299,00€ | screen=true",
        "-12,00 € | pricewatch=1200 | pages=12,00 € | charges=bad:1200 | checkout=12,00€ | screen=true",
        "(12,00 €) | pricewatch=1200 | pages=12,00 € | charges=bad:1200 | checkout=12,00€ | screen=true",
        "12,00 €- | pricewatch=1200 | pages=12,00 € | charges=bad:1200 | checkout=12,00€ | screen=true",
        "$12.00 | pricewatch=null | pages=null | charges=bad: | checkout= | screen=false",
        "£5 | pricewatch=null | pages=null | charges=bad: | checkout=5£ | screen=false",
        "1.299,999 € | pricewatch=null | pages=1.299,999 € | charges=bad: | checkout= | screen=true",
        "12.345.678,00 € | pricewatch=1234567800 | pages=12345678,00 € | charges=bad: | checkout=12.345.678,00€ | screen=true",
        "0,00 € | pricewatch=0 | pages=0,00 € | charges=bad: | checkout=0,00€ | screen=true",
        "99,9 EUR | pricewatch=null | pages=99,90 € | charges=bad: | checkout= | screen=false",
        "precio: 1.234,56 EUR envío 4,99 € | pricewatch=499 | pages=1234,56 € | charges=ok:123456+499 | checkout=1.234,56€+4,99€ | screen=true",
      ]
    `);
  });

  it('números sueltos', () => {
    const rows = RAWS.map((r) =>
      [
        show(r),
        `checkout=${parsePriceToCents(r)}`,
        `pages=${parseAmount(r)?.join(',') ?? 'null'}`,
        `machine=${parseMachinePrice(r)}`,
      ].join(' | '),
    );
    expect(rows).toMatchInlineSnapshot(`
      [
        "1.234,56 | checkout=123456 | pages=1234,56 | machine=123456",
        "45,20 | checkout=4520 | pages=45,20 | machine=4520",
        "300 | checkout=30000 | pages=300,00 | machine=30000",
        "1 299,00 | checkout=129900 | pages=null | machine=null",
        "1<nbsp>299,00 | checkout=129900 | pages=null | machine=null",
        "1,459 | checkout=null | pages=null | machine=null",
        "1.459 | checkout=145900 | pages=1459,00 | machine=null",
        "12,5 | checkout=1250 | pages=12,50 | machine=1250",
        "1.299,999 | checkout=null | pages=null | machine=null",
        "abc | checkout=null | pages=null | machine=null",
        " | checkout=null | pages=null | machine=null",
        "12.34 | checkout=123400 | pages=12,34 | machine=1234",
        "1,234.56 | checkout=null | pages=1234,56 | machine=null",
        "0012 | checkout=1200 | pages=0012,00 | machine=1200",
        "1299.99 | checkout=12999900 | pages=1299,99 | machine=129999",
      ]
    `);
  });
});
