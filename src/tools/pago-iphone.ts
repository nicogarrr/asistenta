import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { AMAZON_ORIGIN } from '../precios/amazon.js';

/**
 * Pagar desde el iPhone (Nico, 7 nov: «Todo» a la idea 5). Asistenta deja el carrito o
 * el enlace de pago listo y lo manda a Telegram con un botón que lo abre en Safari; allí
 * Nico revisa y paga él (Apple Pay con Face ID si la tienda lo ofrece). Esta herramienta
 * NUNCA paga: solo construye el enlace y lo envía. Desde el PC no hay Apple Pay.
 *
 * - Amazon: con ASINs arma el enlace oficial «añadir a la cesta» de amazon.es
 *   (`/gp/aws/cart/add.html?ASIN.1=…&Quantity.1=…`), que mete todo en SU cesta al abrirlo.
 * - Cualquier otra tienda: el enlace https de su carrito o de su pago, tal cual.
 */

export const PAGO_IPHONE_NAME = 'enlace_pago';
export const BOTON_APPLE_PAY = 'Pagar con Apple Pay en Safari';
export const BOTON_AMAZON = 'Abrir la cesta en Safari';
const MAX_PRODUCTOS = 20;
const MAX_URL = 2000;

export interface ProductoAmazon {
  asin: string;
  cantidad?: number;
}

/** El enlace «añadir a la cesta» de amazon.es con todos los productos, o null si alguno no vale. */
export function urlCestaAmazon(productos: readonly ProductoAmazon[]): string | null {
  if (!productos.length || productos.length > MAX_PRODUCTOS) return null;
  const qs: string[] = [];
  productos.forEach((p, i) => {
    const asin = String(p.asin ?? '')
      .trim()
      .toUpperCase();
    const n = Math.round(Number(p.cantidad ?? 1));
    if (!/^[A-Z0-9]{10}$/.test(asin) || !(n >= 1 && n <= 30)) return;
    qs.push(`ASIN.${i + 1}=${asin}&Quantity.${i + 1}=${n}`);
  });
  if (qs.length !== productos.length) return null;
  return `${AMAZON_ORIGIN}/gp/aws/cart/add.html?${qs.join('&')}`;
}

/** Un enlace de carrito o de pago que se puede mandar: https, sin usuario:clave y corto. */
export function enlacePagoValido(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  const s = u.toString();
  return s.length <= MAX_URL ? s : null;
}

function esAmazon(url: string): boolean {
  try {
    return /(^|\.)amazon\.[a-z.]+$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** El mensaje y el botón que se mandan a Telegram. */
export function mensajePago(
  concepto: string,
  url: string,
): { text: string; buttons: Array<{ label: string; action: string }> } {
  const que = concepto.trim().slice(0, 200) || 'Tu compra';
  const amazon = esAmazon(url);
  const text = amazon
    ? `🛒 ${que}: la cesta de Amazon está lista. Ábrela en el iPhone, revisa y paga tú (Amazon cobra con la forma de pago de tu cuenta). Yo no he pagado nada.`
    : `🛒 ${que}: el pago está listo. Ábrelo en Safari, revisa y paga tú con Apple Pay y Face ID (si la tienda no lo ofrece, con tu tarjeta). Yo no he pagado nada.`;
  return {
    text,
    buttons: [{ label: amazon ? BOTON_AMAZON : BOTON_APPLE_PAY, action: `url:${url}` }],
  };
}

export interface PagoIphoneDeps {
  send(
    chatId: string,
    text: string,
    buttons: Array<{ label: string; action: string }>,
  ): Promise<unknown>;
}

const Params = lazySchema(() =>
  Type.Object({
    concepto: Type.String({ description: 'What is being bought, in Spanish (shown to Nico).' }),
    url: Type.Optional(
      Type.String({
        description:
          "https link to the shop's cart or checkout page (any shop except Amazon ASINs).",
      }),
    ),
    amazon: Type.Optional(
      Type.Array(
        Type.Object({
          asin: Type.String({ description: '10-character Amazon ASIN' }),
          cantidad: Type.Optional(Type.Number({ description: 'Quantity, default 1' })),
        }),
        {
          description:
            'Amazon.es products to put in his cart (builds the official add-to-cart link).',
        },
      ),
    ),
  }),
);

export function createPagoIphoneTool(
  deps: PagoIphoneDeps,
  chatId: () => string,
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: PAGO_IPHONE_NAME,
    label: 'Enlace de pago para el iPhone',
    description:
      "Hand a purchase to the owner's iPhone: sends him in Telegram the prepared cart or checkout link with a button that opens it in Safari, where HE pays (Apple Pay / Face ID). Use after preparing a purchase (Amazon ASINs, a shop cart or checkout URL) when he wants to pay himself or asks to pay with Apple Pay. It never pays, never submits a form and needs no card.",
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      let url: string | null = null;
      if (args.amazon?.length) {
        url = urlCestaAmazon(args.amazon);
        if (!url)
          return reply(
            'Algún ASIN no vale (son 10 letras o números) o la cantidad no está entre 1 y 30; no he mandado nada.',
          );
      } else if (args.url?.trim()) {
        url = enlacePagoValido(args.url);
        if (!url)
          return reply(
            'Ese enlace no se puede mandar: tiene que ser https y sin usuario ni clave.',
          );
      } else {
        return reply('Dame el enlace del carrito o del pago, o los ASIN de Amazon.');
      }
      const chat = chatId();
      if (!chat) return reply('No sé a qué chat mandarlo.');
      const m = mensajePago(args.concepto, url);
      try {
        await deps.send(chat, m.text, m.buttons);
      } catch {
        return reply('No he podido mandar el enlace a Telegram ahora mismo.');
      }
      return reply(
        `Enviado a Telegram con el botón «${m.buttons[0]?.label}». No se ha pagado nada: paga él en el iPhone. Enlace: ${url}`,
      );
    },
  };
}

function reply(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}
