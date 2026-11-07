import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { type WdaClient, WdaError } from '../iphone/wda.js';
import { sliceSafe } from '../text.js';

/**
 * `iphone_pantalla`: ver y tocar el iPhone de Nico a través de WebDriverAgent
 * (src/iphone/wda.ts). Opcional y experimental: solo existe con `PA_IPHONE_WDA=1`.
 *
 * `estado`, `pantalla` y `leer` solo miran. `tocar`, `escribir`, `abrir` e `inicio` mueven
 * un teléfono real con cuentas reales: la Gate pregunta CADA vez (src/permissions.ts).
 */

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('estado'),
      Type.Literal('pantalla'),
      Type.Literal('leer'),
      Type.Literal('tocar'),
      Type.Literal('escribir'),
      Type.Literal('abrir'),
      Type.Literal('inicio'),
    ]),
    x: Type.Optional(
      Type.Number({ description: 'tocar: x en puntos de la pantalla (como en «leer»).' }),
    ),
    y: Type.Optional(Type.Number({ description: 'tocar: y en puntos de la pantalla.' })),
    texto: Type.Optional(
      Type.String({ description: 'escribir: el texto, en el campo que tenga el foco.' }),
    ),
    crudo: Type.Optional(
      Type.Boolean({
        description:
          'leer: true da el árbol entero de accesibilidad (largo) en vez del resumen de una línea por elemento.',
      }),
    ),
    bundleId: Type.Optional(
      Type.String({
        description: 'abrir: id de la app, p. ej. net.whatsapp.WhatsApp o com.apple.mobilesafari.',
      }),
    ),
  }),
);

/** Lo que se devuelve de «leer»: el árbol entero puede ser enorme. */
export const WDA_MAX_LEER = 12_000;

const text = (t: string) => ({ type: 'text' as const, text: t });

export function createIphonePantallaTool(
  cliente: () => WdaClient,
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'iphone_pantalla',
    label: 'Pantalla del iPhone',
    description: [
      'Ve y maneja el iPhone de Nico con WebDriverAgent (experimental).',
      'estado: si está conectado. pantalla: captura. leer: lo que hay en pantalla, una línea por elemento con su centro en puntos (vale tal cual para tocar) y el estado de los interruptores; gasta mucho menos que una captura, úsalo primero.',
      'tocar (x, y), escribir (texto), abrir (bundleId) e inicio mueven el teléfono y piden aprobación cada vez.',
      'Mira la pantalla antes de tocar y después para comprobar. Si una orden queda «sin saber si se hizo», mira la pantalla antes de repetirla.',
      'Nunca escribas contraseñas ni códigos salvo que Nico lo pida en esta conversación.',
    ].join(' '),
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const c = cliente();
      try {
        switch (args.action) {
          case 'estado': {
            const e = await c.estado();
            return {
              content: [
                text(
                  `iPhone conectado por WebDriverAgent${e.ios ? ` (iOS ${e.ios})` : ''}${e.listo ? '' : ', pero dice que no está listo'}.`,
                ),
              ],
              details: e,
            };
          }
          case 'pantalla': {
            const png = await c.pantalla();
            return {
              content: [
                text(`Pantalla del iPhone (${png.length} bytes).`),
                { type: 'image' as const, mimeType: 'image/png', data: png.toString('base64') },
              ],
              details: { bytes: png.length },
            };
          }
          case 'leer': {
            const arbol = args.crudo === true ? await c.leerCrudo() : await c.leer();
            const corto =
              arbol.length > WDA_MAX_LEER
                ? `${sliceSafe(arbol, WDA_MAX_LEER)}\n[…recortado]`
                : arbol;
            return {
              content: [text(corto || 'No he podido leer nada en la pantalla.')],
              details: { chars: arbol.length },
            };
          }
          case 'tocar': {
            if (
              typeof args.x !== 'number' ||
              typeof args.y !== 'number' ||
              args.x < 0 ||
              args.y < 0
            ) {
              return {
                content: [text('Para tocar hacen falta x e y (números, en puntos).')],
                details: {},
              };
            }
            await c.tocar(args.x, args.y);
            return {
              content: [
                text(`Tocado en (${args.x}, ${args.y}). Mira la pantalla para comprobarlo.`),
              ],
              details: { entrega: 'hecho' },
            };
          }
          case 'escribir': {
            if (!args.texto)
              return { content: [text('Falta el texto que escribir.')], details: {} };
            await c.escribir(args.texto);
            return {
              content: [text('Escrito. Mira la pantalla para comprobarlo.')],
              details: { entrega: 'hecho' },
            };
          }
          case 'abrir': {
            if (!args.bundleId || !/^[A-Za-z0-9.-]+$/.test(args.bundleId)) {
              return {
                content: [text('Falta el id de la app (bundleId), p. ej. net.whatsapp.WhatsApp.')],
                details: {},
              };
            }
            await c.abrir(args.bundleId);
            return { content: [text(`Abierta ${args.bundleId}.`)], details: { entrega: 'hecho' } };
          }
          case 'inicio': {
            await c.inicio();
            return { content: [text('En la pantalla de inicio.')], details: { entrega: 'hecho' } };
          }
          default:
            return { content: [text('Acción desconocida.')], details: {} };
        }
      } catch (err) {
        const entrega = err instanceof WdaError ? err.entrega : 'desconocido';
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            text(
              entrega === 'no-enviado'
                ? `No se ha hecho: ${msg}`
                : `Sin saber si se ha hecho: ${msg}`,
            ),
          ],
          details: { entrega },
        };
      }
    },
  };
}
