import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';

/**
 * «¿Cuánto son 120 dólares en euros?», «¿a cuánto está la libra?»: cambio de moneda con los
 * tipos de referencia del Banco Central Europeo (Frankfurter, gratis y sin clave). Antes el
 * modelo contestaba de memoria con un tipo de hace meses o buscaba en la web. Solo lectura:
 * no recibe URL del modelo; la única salida a la red es ese servicio con códigos ISO
 * validados.
 */

const Params = lazySchema(() =>
  Type.Object({
    cantidad: Type.Optional(
      Type.Number({ minimum: 0, description: 'Cuánto dinero convertir (por defecto 1).' }),
    ),
    de: Type.String({
      maxLength: 40,
      description: 'Moneda de origen: código ISO (USD) o nombre («dólares», «libras», «yenes»).',
    }),
    a: Type.Optional(
      Type.String({
        maxLength: 80,
        description:
          'Moneda o monedas de destino, separadas por comas (por defecto EUR; «USD, GBP»).',
      }),
    ),
  }),
);

/** Lo que el BCE publica (Frankfurter no da otras). */
const ECB = new Set(
  'EUR USD JPY BGN CZK DKK GBP HUF PLN RON SEK CHF ISK NOK TRY AUD BRL CAD CNY HKD IDR ILS INR KRW MXN MYR NZD PHP SGD THB ZAR'.split(
    ' ',
  ),
);

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Nombres en español (sin tildes) → código ISO. Lo más específico primero. */
const NAMES: Array<[RegExp, string]> = [
  [/dolar(es)? (canadiense|de canada)/, 'CAD'],
  [/dolar(es)? (australiano|de australia)/, 'AUD'],
  [/dolar(es)? (neozelandes|de nueva zelanda)/, 'NZD'],
  [/dolar(es)? (de )?(hong ?kong|hongkones)/, 'HKD'],
  [/dolar(es)? (de )?singapur/, 'SGD'],
  [/franco(s)? suizo|franco(s)?$/, 'CHF'],
  [/corona(s)? sueca|corona(s)? de suecia/, 'SEK'],
  [/corona(s)? noruega|corona(s)? de noruega/, 'NOK'],
  [/corona(s)? danesa|corona(s)? de dinamarca/, 'DKK'],
  [/corona(s)? checa/, 'CZK'],
  [/corona(s)? islandesa/, 'ISK'],
  [/peso(s)? mexicano|peso(s)? de mexico/, 'MXN'],
  [/peso(s)? filipino/, 'PHP'],
  [/libra(s)? esterlina|libra(s)?$|£/, 'GBP'],
  [/dolar(es)?|\$|usd/, 'USD'],
  [/euro(s)?|€/, 'EUR'],
  [/yen(es)?|¥/, 'JPY'],
  [/yuan(es)?|renminbi/, 'CNY'],
  [/real(es)?( brasileno)?/, 'BRL'],
  [/rupia(s)? (india|de la india)|rupia(s)?$/, 'INR'],
  [/rupia(s)? indonesia/, 'IDR'],
  [/zloty(s)?|esloti(s)?/, 'PLN'],
  [/florin(es)?|forint(s)?/, 'HUF'],
  [/leu|lei/, 'RON'],
  [/lev(a)?/, 'BGN'],
  [/lira(s)?( turca)?/, 'TRY'],
  [/won(es)?/, 'KRW'],
  [/rand(s)?/, 'ZAR'],
  [/baht/, 'THB'],
  [/shekel(s)?|sequel(es)?/, 'ILS'],
  [/ringgit/, 'MYR'],
];

/** Monedas que se piden a menudo y el BCE no publica: se dice claro en vez de inventar. */
const NOT_ECB: Array<[RegExp, string]> = [
  [/bitcoin|btc|cripto|ethereum|eth\b/, 'las criptomonedas'],
  [/peso(s)? argentino|ars\b/, 'el peso argentino'],
  [/peso(s)? (colombiano|chileno|uruguayo|cubano)|cop\b|clp\b|uyu\b/, 'ese peso'],
  [/rublo|rub\b/, 'el rublo'],
  [/sol(es)? peruano|pen\b/, 'el sol peruano'],
  [/dirham|aed\b|mad\b/, 'el dírham'],
];

/** Código ISO de lo que escribió, o un motivo si no se puede. */
export function currencyCode(raw: string): { code: string } | { error: string } {
  const t = fold(raw);
  if (!t) return { error: 'Dime qué moneda.' };
  const upper = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && ECB.has(upper)) return { code: upper };
  for (const [re, why] of NOT_ECB)
    if (re.test(t))
      return {
        error: `No tengo el cambio oficial de ${why}: el Banco Central Europeo no lo publica. Para eso busco en la web si quieres.`,
      };
  for (const [re, code] of NAMES) if (re.test(t)) return { code };
  return {
    error: `No reconozco la moneda «${raw.trim()}». Dímela con su código de tres letras (USD, GBP, JPY…).`,
  };
}

const money = (n: number, max = 2): string =>
  new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: n !== 0 && Math.abs(n) < 1 ? Math.min(4, max + 2) : 2,
    maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? Math.min(4, max + 2) : max,
  }).format(n);

const rate = (n: number): string =>
  new Intl.NumberFormat('es-ES', { maximumSignificantDigits: 5 }).format(n);

const dayEs = (d: string): string => {
  const at = new Date(`${d}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return d;
  return new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
};

const DOWN =
  'No pude consultar el cambio ahora: el servicio del BCE no responde. Prueba en un rato.';

export function createDivisasTool(
  fetchFn: typeof fetch = fetch,
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'divisas',
    label: 'Cambio de moneda',
    description:
      'Currency conversion with the European Central Bank reference rates (Frankfurter, no key; updated on working days around 16:00 CET). Use for «¿cuánto son 120 dólares en euros?», «¿a cuánto está la libra?», «50 € en yenes». Covers the ~30 ECB currencies (not crypto, ARS, COP, RUB…). Read-only.',
    parameters: Params(),
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        const from = currencyCode(args.de);
        if ('error' in from) return from.error;
        const targets: string[] = [];
        for (const part of (args.a?.trim() || 'EUR').split(/,| y /)) {
          if (!part.trim()) continue;
          const to = currencyCode(part);
          if ('error' in to) return to.error;
          if (to.code !== from.code && !targets.includes(to.code)) targets.push(to.code);
        }
        if (targets.length === 0)
          return from.code === 'EUR'
            ? 'Dime a qué moneda quieres pasar los euros.'
            : `Es la misma moneda (${from.code}).`;
        const amount = typeof args.cantidad === 'number' && args.cantidad >= 0 ? args.cantidad : 1;
        const url =
          'https://api.frankfurter.dev/v1/latest' +
          `?base=${from.code}&symbols=${targets.join(',')}`;
        let body: { date?: string; rates?: Record<string, unknown> };
        try {
          const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          body = (await res.json()) as typeof body;
        } catch (err) {
          log.warn('divisas: fallo al consultar', { err: String(err) });
          return DOWN;
        }
        const lines: string[] = [];
        for (const code of targets) {
          const r = body.rates?.[code];
          if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) continue;
          const head =
            amount === 1
              ? `1 ${from.code} = ${rate(r)} ${code}`
              : `${money(amount)} ${from.code} = ${money(amount * r)} ${code} (1 ${from.code} = ${rate(r)} ${code})`;
          lines.push(head);
        }
        if (lines.length === 0) return 'El servicio del BCE no ha devuelto ese cambio ahora.';
        const when = body.date ? ` del ${dayEs(body.date)}` : '';
        return `${lines.join('\n')}\nTipo de referencia del BCE${when} (el banco o la tarjeta suelen cobrar algo más).`;
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
