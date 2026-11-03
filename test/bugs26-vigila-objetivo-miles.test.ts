import { describe, expect, it } from 'vitest';
import { parseVigilaArgs } from '../src/watch/pages.js';

/**
 * /vigila con objetivo escrito como se escribe en España: «objetivo=1.299€» (punto de
 * miles) contestaba «No entiendo el objetivo», «objetivo=500eur» también, y con
 * «objetivo=500 euros tele» la vigilancia se llamaba «euros tele». Ahora se entienden.
 */
describe('/vigila: objetivo con punto de miles o «euros»', () => {
  it.each([
    ['https://x.es/p objetivo=1.299€ portátil', 129900, 'portátil'],
    ['https://x.es/p objetivo=1.299 € portátil', 129900, 'portátil'],
    ['https://x.es/p objetivo=2.000.000€', 200000000, ''],
    ['https://x.es/p objetivo=500 euros tele', 50000, 'tele'],
    ['https://x.es/p objetivo=500eur', 50000, ''],
    ['https://x.es/p objetivo=500 Euros', 50000, ''],
  ])('%s', (args, targetCents, label) => {
    expect(parseVigilaArgs(args)).toMatchObject({ targetCents, label });
  });

  it('lo de antes no cambia y lo ambiguo sigue preguntando', () => {
    expect(parseVigilaArgs('https://x.es/p objetivo=1.299,50€')?.targetCents).toBe(129950);
    expect(parseVigilaArgs('https://x.es/p objetivo=12.5€')?.targetCents).toBe(1250);
    expect(parseVigilaArgs('https://x.es/p objetivo=1299.50')?.targetCents).toBe(129950);
    expect(parseVigilaArgs('https://x.es/p objetivo=1,299.99€')?.targetCents).toBe(129999);
    expect(() => parseVigilaArgs('https://x.es/p objetivo=1,299€')).toThrow(/objetivo/);
    expect(() => parseVigilaArgs('https://x.es/p objetivo=barato')).toThrow(/objetivo/);
  });
});
