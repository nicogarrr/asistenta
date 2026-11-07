import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import {
  asuntoOrden,
  avisoSinRespuesta,
  cuerpoOrden,
  esAccion,
  ORDEN_ACCIONES,
  ORDEN_SIN_RESPUESTA_MS,
  type OrdenesStore,
  resumenOrden,
  validarOrden,
} from '../iphone/ordenes.js';

/**
 * `iphone_orden`: Asistenta hace cosas en el iPhone de Nico mandándole un correo que una
 * automatización de Atajos ejecuta (src/iphone/ordenes.ts, docs/atajos-iphone.md).
 *
 * `estado` y `configurar` solo leen. Todo lo demás sale del PC hacia el teléfono (y
 * un WhatsApp o un iMessage llega a otra persona): la Gate pregunta siempre.
 */

export interface IphoneOrdenDeps {
  store: OrdenesStore;
  /** El correo del iPhone (el de su app Mail) y el remitente que la automatización filtra. */
  correos: () => Promise<{ iphone: string; remitente: string } | null>;
  enviar: (to: string, subject: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** Avisa en Telegram si el iPhone no confirma a tiempo. */
  avisar?: (texto: string) => Promise<unknown>;
  /** URL de /api/atajo/resultado para las recetas, si se sabe. */
  urlResultado?: () => Promise<string | null>;
  esperaMs?: number;
}

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('estado'),
      Type.Literal('configurar'),
      ...ORDEN_ACCIONES.map((a) => Type.Literal(a)),
    ]),
    app: Type.Optional(
      Type.String({ description: 'abrir_app: nombre de la app («WhatsApp», «Spotify»…).' }),
    ),
    para: Type.Optional(
      Type.String({
        description: 'whatsapp/imessage: el contacto tal como está en la agenda del iPhone.',
      }),
    ),
    texto: Type.Optional(
      Type.String({ description: 'whatsapp/imessage: el mensaje; recordatorio: el texto.' }),
    ),
    titulo: Type.Optional(Type.String({ description: 'evento: el título.' })),
    cuando: Type.Optional(
      Type.String({
        description:
          'evento (obligatorio) o recordatorio: fecha y hora, p. ej. «2026-11-08 18:00» o «mañana a las 9».',
      }),
    ),
    fin: Type.Optional(Type.String({ description: 'evento: hora de fin (opcional).' })),
    busqueda: Type.Optional(Type.String({ description: 'musica: canción, artista o lista.' })),
  }),
);

const text = (t: string) => ({ type: 'text' as const, text: t });

export function createIphoneOrdenTool(deps: IphoneOrdenDeps): AgentTool<ReturnType<typeof Params>> {
  const espera = deps.esperaMs ?? ORDEN_SIN_RESPUESTA_MS;
  return {
    name: 'iphone_orden',
    label: 'Orden al iPhone',
    description: [
      'Hace algo en el iPhone de Nico: abrir una app, mandar un WhatsApp o un iMessage, crear un recordatorio o un evento, o poner música.',
      'Funciona mandando un correo que su atajo «Orden de Asistenta» ejecuta solo; el iPhone confirma después.',
      'Cada orden pide aprobación. «estado» dice si está configurado y qué queda sin confirmar; «configurar» da los pasos.',
      'No sirve para leer la pantalla ni tocar botones dentro de otras apps.',
    ].join(' '),
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, params) => {
      const action = params.action;
      if (action === 'estado' || action === 'configurar') {
        const correos = await deps.correos();
        const pendientes = deps.store.pendientes();
        const lineas = [
          correos
            ? `Configurado: mando las órdenes a ${correos.iphone} desde ${correos.remitente}.`
            : 'Sin configurar: falta la cuenta de correo de Asistenta (/correo) o PA_IPHONE_CORREO.',
          `Clave del asunto: ASIS-${deps.store.clave()}`,
          pendientes.length
            ? `Sin confirmar: ${pendientes.map((p) => `#${p.id} ${p.resumen}`).join('; ')}`
            : 'No hay órdenes sin confirmar.',
        ];
        if (action === 'configurar')
          lineas.push('Los pasos para el iPhone están en /atajos (Telegram).');
        return { content: [text(lineas.join('\n'))], details: { pendientes: pendientes.length } };
      }
      if (!esAccion(action)) {
        return { content: [text(`Acción desconocida: ${String(action)}.`)], details: {} };
      }
      const v = validarOrden(action, params as Record<string, unknown>);
      if ('error' in v) return { content: [text(v.error)], details: {} };
      const correos = await deps.correos();
      if (!correos) {
        return {
          content: [
            text(
              'No puedo mandar órdenes al iPhone: falta la cuenta de correo de Asistenta. Configúrala con /correo y monta el atajo con /atajos.',
            ),
          ],
          details: {},
        };
      }
      const orden = deps.store.crear(action, v.params);
      const r = await deps.enviar(
        correos.iphone,
        asuntoOrden(deps.store.clave(), orden),
        cuerpoOrden(orden),
      );
      if (!r.ok) {
        deps.store.cerrar(orden.id);
        return {
          content: [
            text(`No he podido mandar la orden al iPhone: ${r.error ?? 'fallo del correo'}.`),
          ],
          details: { ok: false },
        };
      }
      const resumen = resumenOrden(orden);
      if (deps.avisar && espera > 0) {
        const avisar = deps.avisar;
        const t = setTimeout(() => {
          const p = deps.store.pendiente(orden.id);
          if (p) void Promise.resolve(avisar(avisoSinRespuesta(p))).catch(() => {});
        }, espera);
        t.unref?.();
      }
      return {
        content: [
          text(
            `Orden #${orden.id} mandada al iPhone: ${resumen}. Aún no está hecha: el iPhone la confirma por su cuenta y lo diré en Telegram.`,
          ),
        ],
        details: { ok: true, id: orden.id },
      };
    },
  };
}
