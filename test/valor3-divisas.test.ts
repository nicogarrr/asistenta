/**
 * Nuevo tool «divisas»: «¿cuánto son 120 dólares en euros?», «¿a cuánto está la libra?».
 * Antes el modelo respondía de memoria (con un tipo de hace meses) o buscaba en la web.
 * Ahora usa los tipos de referencia del BCE (Frankfurter, gratis, sin clave), con la fecha
 * del tipo; entiende nombres en español y dice claro qué monedas no publica el BCE.
 * Red simulada.
 */
import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { createDivisasTool, currencyCode } from '../src/tools/divisas.js';

function net(urls: string[], rates: Record<string, number>, date = '2026-11-04'): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const wanted = (url.searchParams.get('symbols') ?? '').split(',');
    const out: Record<string, number> = {};
    for (const s of wanted) if (rates[s] !== undefined) out[s] = rates[s] as number;
    return new Response(
      JSON.stringify({ amount: 1, base: url.searchParams.get('base'), date, rates: out }),
      { status: 200 },
    );
  }) as typeof fetch;
}

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('tool divisas', () => {
  it('«120 dólares en euros» con el tipo del BCE y su fecha', async () => {
    const urls: string[] = [];
    const tool = createDivisasTool(net(urls, { EUR: 0.9204 }));
    const out = textOf(await tool.execute('t', { cantidad: 120, de: 'dólares', a: 'euros' }));
    expect(out).toContain('120,00 USD = 110,45 EUR (1 USD = 0,9204 EUR)');
    expect(out).toContain('Tipo de referencia del BCE del 4 nov 2026');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').host).toBe('api.frankfurter.dev');
    expect(urls[0]).toContain('base=USD');
    expect(urls[0]).toContain('symbols=EUR');
  });

  it('«¿a cuánto está la libra?»: por defecto a euros; varias de destino a la vez', async () => {
    const urls: string[] = [];
    const tool = createDivisasTool(net(urls, { EUR: 1.1891, USD: 1.2934, JPY: 198.12 }));
    expect(textOf(await tool.execute('t', { de: 'libras' }))).toContain('1 GBP = 1,1891 EUR');
    const many = textOf(await tool.execute('t', { cantidad: 50, de: 'GBP', a: 'USD, yenes' }));
    expect(many).toContain('50,00 GBP = 64,67 USD');
    expect(many).toContain('50,00 GBP = 9906,00 JPY');
  });

  it('entiende nombres en español y códigos', () => {
    expect(currencyCode('dólares canadienses')).toEqual({ code: 'CAD' });
    expect(currencyCode('francos suizos')).toEqual({ code: 'CHF' });
    expect(currencyCode('pesos mexicanos')).toEqual({ code: 'MXN' });
    expect(currencyCode('coronas suecas')).toEqual({ code: 'SEK' });
    expect(currencyCode('€')).toEqual({ code: 'EUR' });
    expect(currencyCode('usd')).toEqual({ code: 'USD' });
    expect(currencyCode('zlotys')).toEqual({ code: 'PLN' });
  });

  it('lo que el BCE no publica lo dice sin inventar y sin salir a la red', async () => {
    const urls: string[] = [];
    const tool = createDivisasTool(net(urls, {}));
    expect(textOf(await tool.execute('t', { de: 'bitcoin' }))).toContain('criptomonedas');
    expect(textOf(await tool.execute('t', { de: 'EUR', a: 'pesos argentinos' }))).toContain(
      'peso argentino',
    );
    expect(textOf(await tool.execute('t', { de: 'doblones' }))).toContain('No reconozco');
    expect(urls).toHaveLength(0);
  });

  it('un fallo del servicio se cuenta sin romper el turno', async () => {
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const out = textOf(await createDivisasTool(down).execute('t', { de: 'USD' }));
    expect(out).toContain('no responde');
  });

  it('la Gate lo trata como lectura', () => {
    const gate = new Gate();
    expect(gate.classifyEffect({ tool: 'divisas', args: { de: 'USD' }, actor: 'test' })).toBe(
      'lee',
    );
  });
});
