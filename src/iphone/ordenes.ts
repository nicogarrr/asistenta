/**
 * Órdenes de Asistenta al iPhone por correo (Nico, 7 nov: «Quiero hacerlo yo… con Asistenta»).
 *
 * El PC no puede lanzar un atajo en el iPhone. Lo que sí puede es mandar un correo, y desde
 * iOS 17 una automatización de Atajos «Al recibir un correo de…» se ejecuta sola. Así:
 *
 * 1. Asistenta manda un correo con el asunto `ASIS-<clave> <acción> #<id>` y, en el cuerpo,
 *    una línea JSON con la orden (`{"id":7,"accion":"whatsapp","para":"Mamá","texto":"…"}`).
 * 2. En el iPhone, la automatización (remitente = el correo de Asistenta, asunto contiene
 *    `ASIS-<clave>`) ejecuta el atajo «Orden de Asistenta», que lee el JSON y hace la acción
 *    con las acciones normales de Atajos: abrir una app, WhatsApp, iMessage, recordatorio,
 *    evento o música.
 * 3. El atajo contesta en `POST /api/atajo/resultado` (`{id, ok, detalle}`) y Asistenta lo
 *    dice en Telegram. Si en 5 minutos no ha contestado, Asistenta también lo dice.
 *
 * La clave es aleatoria y vive en el estado: sin ella, otro correo no dispara el atajo.
 * Mandar un mensaje a alguien sale del PC y no se puede deshacer: la Gate pregunta cada
 * vez (src/permissions.ts, `iphone_orden`).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setAsideCorrupt, writeFileReplacing } from '../fs-tmp.js';
import { sliceSafe } from '../text.js';

export const ORDEN_ACCIONES = [
  'abrir_app',
  'whatsapp',
  'imessage',
  'recordatorio',
  'evento',
  'musica',
] as const;
export type OrdenAccion = (typeof ORDEN_ACCIONES)[number];

export interface OrdenParams {
  app?: string;
  para?: string;
  texto?: string;
  titulo?: string;
  cuando?: string;
  fin?: string;
  busqueda?: string;
}

export interface Orden extends OrdenParams {
  id: number;
  accion: OrdenAccion;
}

/** Lo que cada acción necesita, en el orden en que el atajo lo lee. */
const REQUIERE: Record<OrdenAccion, ReadonlyArray<keyof OrdenParams>> = {
  abrir_app: ['app'],
  whatsapp: ['para', 'texto'],
  imessage: ['para', 'texto'],
  recordatorio: ['texto'],
  evento: ['titulo', 'cuando'],
  musica: ['busqueda'],
};

const CAMPOS: ReadonlyArray<keyof OrdenParams> = [
  'app',
  'para',
  'texto',
  'titulo',
  'cuando',
  'fin',
  'busqueda',
];

/** Tope por campo: un atajo y un asunto de correo no son sitio para un documento. */
export const ORDEN_MAX_CAMPO = 1000;

export function esAccion(x: unknown): x is OrdenAccion {
  return typeof x === 'string' && (ORDEN_ACCIONES as readonly string[]).includes(x);
}

/** Valida y limpia los parámetros; `error` en castellano si falta algo. */
export function validarOrden(
  accion: OrdenAccion,
  raw: Record<string, unknown>,
): { params: OrdenParams } | { error: string } {
  const params: OrdenParams = {};
  for (const campo of CAMPOS) {
    const v = raw[campo];
    if (typeof v !== 'string') continue;
    // Una orden es una línea JSON: fuera saltos raros y caracteres de control.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: se quitan a propósito
    const limpio = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (limpio) params[campo] = sliceSafe(limpio, ORDEN_MAX_CAMPO);
  }
  const faltan = REQUIERE[accion].filter((c) => !params[c]);
  if (faltan.length) return { error: `Para «${accion}» falta: ${faltan.join(', ')}.` };
  return { params };
}

export function asuntoOrden(clave: string, orden: Orden): string {
  return `ASIS-${clave} ${orden.accion} #${orden.id}`;
}

/** El cuerpo: una sola línea JSON, que el atajo convierte en diccionario. */
export function cuerpoOrden(orden: Orden): string {
  const out: Record<string, unknown> = { id: orden.id, accion: orden.accion };
  for (const campo of CAMPOS) if (orden[campo]) out[campo] = orden[campo];
  return JSON.stringify(out);
}

/** Frase corta de la orden para Telegram y para la aprobación. */
export function resumenOrden(o: OrdenParams & { accion: OrdenAccion }): string {
  const t = (s?: string) => (s && s.length > 60 ? `${sliceSafe(s, 59)}…` : (s ?? ''));
  switch (o.accion) {
    case 'abrir_app':
      return `abrir ${o.app}`;
    case 'whatsapp':
      return `WhatsApp a ${o.para}: «${t(o.texto)}»`;
    case 'imessage':
      return `iMessage a ${o.para}: «${t(o.texto)}»`;
    case 'recordatorio':
      return `recordatorio «${t(o.texto)}»${o.cuando ? ` (${o.cuando})` : ''}`;
    case 'evento':
      return `evento «${t(o.titulo)}» el ${o.cuando}`;
    case 'musica':
      return `poner «${t(o.busqueda)}»`;
  }
}

interface Pendiente {
  id: number;
  accion: OrdenAccion;
  resumen: string;
  at: number;
}

interface EstadoOrdenes {
  clave: string;
  siguiente: number;
  pendientes: Pendiente[];
}

/** Pendientes que se guardan como mucho (las viejas se olvidan). */
const MAX_PENDIENTES = 50;

function nuevaClave(): string {
  // 8 caracteres en minúscula y cifras: se teclea una vez en la automatización.
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...randomBytes(8)].map((b) => abc[b % abc.length]).join('');
}

/** `<estado>/iphone-ordenes.json`: la clave, el siguiente id y las órdenes sin respuesta. */
export class OrdenesStore {
  readonly #path: string;
  readonly #now: () => number;
  #estado: EstadoOrdenes | null = null;

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  #leer(): EstadoOrdenes {
    if (this.#estado) return this.#estado;
    let estado: EstadoOrdenes | null = null;
    if (existsSync(this.#path)) {
      try {
        const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<EstadoOrdenes>;
        if (typeof raw.clave === 'string' && /^[a-z0-9]{6,32}$/.test(raw.clave)) {
          estado = {
            clave: raw.clave,
            siguiente:
              Number.isInteger(raw.siguiente) && Number(raw.siguiente) > 0
                ? Number(raw.siguiente)
                : 1,
            pendientes: Array.isArray(raw.pendientes)
              ? raw.pendientes.filter((p) => Number.isInteger(p?.id))
              : [],
          };
        }
      } catch {
        setAsideCorrupt(this.#path);
      }
    }
    this.#estado = estado ?? { clave: nuevaClave(), siguiente: 1, pendientes: [] };
    if (!estado) this.#guardar();
    return this.#estado;
  }

  #guardar(): void {
    if (this.#estado)
      writeFileReplacing(this.#path, `${JSON.stringify(this.#estado, null, 2)}\n`, { mode: 0o600 });
  }

  clave(): string {
    return this.#leer().clave;
  }

  /** Reserva un id y apunta la orden como pendiente. */
  crear(accion: OrdenAccion, params: OrdenParams): Orden {
    const e = this.#leer();
    const orden: Orden = { id: e.siguiente, accion, ...params };
    e.siguiente += 1;
    e.pendientes.push({ id: orden.id, accion, resumen: resumenOrden(orden), at: this.#now() });
    if (e.pendientes.length > MAX_PENDIENTES)
      e.pendientes.splice(0, e.pendientes.length - MAX_PENDIENTES);
    this.#guardar();
    return orden;
  }

  /** Quita una orden de pendientes (se mandó mal o ya contestó). */
  cerrar(id: number): Pendiente | null {
    const e = this.#leer();
    const i = e.pendientes.findIndex((p) => p.id === id);
    if (i === -1) return null;
    const [p] = e.pendientes.splice(i, 1);
    this.#guardar();
    return p ?? null;
  }

  pendiente(id: number): Pendiente | null {
    return this.#leer().pendientes.find((p) => p.id === id) ?? null;
  }

  pendientes(): readonly Pendiente[] {
    return this.#leer().pendientes;
  }
}

/**
 * `POST /api/atajo/resultado`: el atajo dice cómo fue. Devuelve lo que se dice en
 * Telegram (o null si no hay nada que decir) y lo que contesta al atajo.
 */
export function registrarResultado(
  store: OrdenesStore,
  body: Record<string, unknown>,
): { telegram: string | null; respuesta: string; status: number } {
  const id = typeof body.id === 'number' ? body.id : Number.parseInt(String(body.id ?? ''), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { telegram: null, respuesta: 'Falta el número de la orden.', status: 400 };
  }
  const p = store.cerrar(id);
  if (!p) return { telegram: null, respuesta: 'Esa orden ya estaba apuntada.', status: 200 };
  const ok = body.ok === true || body.ok === 'true' || body.ok === 'sí' || body.ok === 'si';
  const detalle =
    typeof body.detalle === 'string' && body.detalle.trim()
      ? ` (${sliceSafe(body.detalle.trim(), 200)})`
      : '';
  return {
    telegram: ok
      ? `✅ Hecho en el iPhone: ${p.resumen}${detalle}`
      : `⚠️ El iPhone no ha podido: ${p.resumen}${detalle}`,
    respuesta: 'Apuntado.',
    status: 200,
  };
}

/** Aviso cuando el iPhone no contesta a tiempo. */
export const ORDEN_SIN_RESPUESTA_MS = 5 * 60_000;

export function avisoSinRespuesta(p: { id: number; resumen: string }): string {
  return `📱 El iPhone no ha confirmado la orden #${p.id} (${p.resumen}). Mira que tenga Mail con este correo, datos o wifi, y la automatización «Al recibir un correo» activada. Escribe /atajos para ver cómo se monta.`;
}

/** Las recetas de /atajos para las órdenes (docs/atajos-iphone.md, sección «Órdenes»). */
export function recetasOrdenes(o: {
  remitente: string;
  clave: string;
  urlResultado: string;
}): string {
  return [
    '📨 Órdenes desde Asistenta (que yo haga cosas en tu iPhone: abrir una app, mandar un WhatsApp o un iMessage, un recordatorio, un evento o poner música). Antes de cada una te pido permiso aquí.',
    '',
    '1) Atajo «Orden de Asistenta»:',
    '• Obtener diccionario de: Entrada del atajo (el cuerpo del correo es una línea JSON)',
    '• Obtener valor de «accion» en el diccionario, y luego Si accion es…',
    '  - abrir_app → Abrir app (valor «app»)',
    '  - whatsapp → Enviar mensaje de WhatsApp a «para» con «texto»',
    '  - imessage → Enviar mensaje a «para» con «texto»',
    '  - recordatorio → Añadir recordatorio «texto» (fecha «cuando» si viene)',
    '  - evento → Añadir evento «titulo» el «cuando»',
    '  - musica → Buscar en Apple Music «busqueda» y Reproducir',
    `• Al final: Obtener contenido de URL ${o.urlResultado} (POST, el mismo encabezado Authorization; JSON id = valor «id», ok = true)`,
    '',
    '2) Automatización: Automatización → Nueva → Correo electrónico:',
    `• Remitente: ${o.remitente}`,
    `• Asunto contiene: ASIS-${o.clave}`,
    '• «Ejecutar inmediatamente» y acción: Ejecutar atajo «Orden de Asistenta».',
    '',
    'Necesita ese correo en la app Mail del iPhone. Si no confirma en 5 minutos, te lo digo aquí.',
  ].join('\n');
}
