import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  compactTokensFromEnv,
  countUnverified,
  estimateTokens,
  isSummary,
  UNVERIFIED_WARNING,
} from '../core/history.js';
import { sliceSafe } from '../text.js';

/**
 * Tarjeta «Contexto» del panel (solo lectura): de qué está hecho ahora el contexto de
 * cada conversación abierta y cuánto falta para el resumen automático.
 *
 * Solo números y nombres: nunca el texto de las instrucciones, de los mensajes ni de
 * la nota de memoria. Los tokens son la misma estimación que usa el resumen automático
 * (`estimateTokens`, 4 caracteres ≈ 1 token, una imagen ≈ 1.500), por eso van como
 * «aprox.»: el proveedor cuenta con su propio tokenizador.
 */

/** Lo que el daemon sabe de un hilo; el panel no ve la clave del chat. */
export interface ContextoFuente {
  /** Nombre corto del hilo (`/topics`). */
  titulo: string;
  /** Hay un turno ejecutándose ahora mismo. */
  activo: boolean;
  modelo: string;
  tools: readonly { name: string; description?: string; parameters?: unknown }[];
  messages: readonly AgentMessage[];
  /** Ventana del modelo en tokens. */
  ventana: number;
  /** Umbral del resumen automático (ya ajustado a la ventana); 0 o menos = apagado. */
  umbralResumen: number;
  /** Resúmenes hechos desde que arrancó el hilo. */
  resumenes: number;
}

export type ParteId = 'instrucciones' | 'herramientas' | 'adjuntos' | 'resumen' | 'conversacion';

export interface ParteContexto {
  id: ParteId;
  nombre: string;
  tokens: number;
  /** Detalle corto («42 herramientas», «18 mensajes · 2 imágenes»). */
  detalle: string;
}

export interface HiloContexto {
  titulo: string;
  estado: 'respondiendo' | 'en espera';
  modelo: string;
  partes: ParteContexto[];
  total: number;
  ventana: number;
  /** Porcentaje de la ventana ocupado (0–100, entero). */
  porcentaje: number;
  /** Lo que mira el resumen automático: todos los mensajes del historial (sin las herramientas). */
  historial: number;
  umbralResumen: number;
  /** Tokens que faltan para el resumen automático; null si está apagado. */
  faltanParaResumen: number | null;
  resumenApagado: boolean;
  resumenes: number;
  /** ISO del último resumen que sigue en el historial; null si no hay. */
  ultimoResumen: string | null;
  /**
   * Datos del resumen marcados «SIN VERIFICAR:» (Hermes `UNVERIFIED:`): lo que el asistente
   * dio por hecho sin comprobarlo antes de resumir. Solo el número, nunca el texto.
   */
  sinVerificar: number;
  /** Nombres de las herramientas cargadas (solo nombres, con tope). */
  herramientas: string[];
  herramientasRecortadas: number;
}

export interface PanelContexto {
  hilos: HiloContexto[];
  /** Hilos de otros chats (grupos): solo se cuentan. */
  otros: number;
  aprox: true;
  nota: string;
}

export const MAX_HILOS = 20;
export const MAX_NOMBRES_HERRAMIENTAS = 80;
const NOTA =
  'Tokens aprox. (4 caracteres ≈ 1 token; imagen ≈ 1.500). El resumen automático mira el historial, sin las herramientas.';

function plural(n: number, uno: string, varios: string): string {
  return `${n.toLocaleString('es-ES')} ${n === 1 ? uno : varios}`;
}

function aprox(chars: number): number {
  return Math.ceil(chars / 4);
}

function toolChars(t: { name: string; description?: string; parameters?: unknown }): number {
  try {
    return JSON.stringify({
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? {},
    }).length;
  } catch {
    return t.name.length + (t.description?.length ?? 0);
  }
}

function imagenes(m: AgentMessage): number {
  const c = (m as { content?: unknown }).content;
  if (!Array.isArray(c)) return 0;
  return c.filter((b) => (b as { type?: unknown })?.type === 'image').length;
}

function role(m: AgentMessage): string {
  return String((m as { role?: unknown }).role ?? '');
}

/** El texto de un mensaje (cadena o bloques de texto). */
function textoDe(m: AgentMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((b) => {
      const t = (b as { text?: unknown })?.text;
      return typeof t === 'string' ? t : '';
    })
    .join('\n');
}

function textoDeSistema(m: AgentMessage): number {
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c))
    return c.reduce(
      (n: number, b) =>
        n +
        (typeof (b as { text?: unknown })?.text === 'string'
          ? (b as { text: string }).text.length
          : 0),
      0,
    );
  return 0;
}

/**
 * ¿Es el mensaje de sistema que lleva las instrucciones? En pi el prompt y las
 * herramientas declaradas viajan en mensajes de sistema del historial: el primero, o
 * los que anuncian herramientas (`toolsAdded`/`toolsRemoved`) o traen `sections`. La
 * nota de contexto (memoria, rutinas, fecha) es un mensaje de sistema solo con texto.
 */
function esInstrucciones(m: AgentMessage, i: number): boolean {
  const o = m as { toolsAdded?: unknown; toolsRemoved?: unknown; sections?: unknown };
  return (
    i === 0 ||
    o.toolsAdded !== undefined ||
    o.toolsRemoved !== undefined ||
    o.sections !== undefined
  );
}

/** Pura: el desglose de un hilo. */
export function contextoDeHilo(f: ContextoFuente): HiloContexto {
  const herramientas = f.tools.reduce((n, t) => n + aprox(toolChars(t)), 0);
  let instrucciones = 0;
  let caracteresPrompt = 0;
  let adjuntos = 0;
  let notas = 0;
  let resumen = 0;
  let ultimo: number | null = null;
  let conversacion = 0;
  let mensajes = 0;
  let fotos = 0;
  let sinVerificar = 0;
  for (const [i, m] of f.messages.entries()) {
    const t = estimateTokens(m);
    if (isSummary(m)) {
      resumen += t;
      // El aviso que va bajo la cabecera nombra la marca: no cuenta como dato.
      sinVerificar += countUnverified(textoDe(m).replaceAll(UNVERIFIED_WARNING, ''));
      const ts = (m as { timestamp?: unknown }).timestamp;
      if (typeof ts === 'number' && Number.isFinite(ts)) ultimo = Math.max(ultimo ?? 0, ts);
    } else if (role(m) === 'system') {
      if (esInstrucciones(m, i)) {
        instrucciones += t;
        caracteresPrompt += textoDeSistema(m);
      } else {
        if (t > 0) notas++;
        adjuntos += t;
      }
    } else {
      conversacion += t;
      mensajes++;
      fotos += imagenes(m);
    }
  }
  const partes: ParteContexto[] = [
    {
      id: 'instrucciones',
      nombre: 'Instrucciones del sistema',
      tokens: instrucciones,
      detalle: plural(caracteresPrompt, 'carácter', 'caracteres'),
    },
    {
      id: 'herramientas',
      nombre: 'Herramientas',
      tokens: herramientas,
      detalle: plural(f.tools.length, 'herramienta', 'herramientas'),
    },
    {
      id: 'adjuntos',
      nombre: 'Memoria y notas adjuntas',
      tokens: adjuntos,
      detalle: notas ? plural(notas, 'nota (memoria, rutinas, fecha)', 'notas') : 'ninguna',
    },
    {
      id: 'resumen',
      nombre: 'Resumen de lo anterior',
      tokens: resumen,
      detalle: resumen
        ? `resumen automático${sinVerificar ? ` · ${plural(sinVerificar, 'dato sin verificar', 'datos sin verificar')}` : ''}`
        : 'sin resumen todavía',
    },
    {
      id: 'conversacion',
      nombre: 'Conversación',
      tokens: conversacion,
      detalle:
        plural(mensajes, 'mensaje', 'mensajes') +
        (fotos ? ` · ${plural(fotos, 'imagen', 'imágenes')}` : ''),
    },
  ];
  const total = partes.reduce((n, p) => n + p.tokens, 0);
  const ventana = Number.isFinite(f.ventana) && f.ventana > 0 ? Math.floor(f.ventana) : 0;
  // Lo mismo que mira el resumen automático: todo el historial (las herramientas no).
  const historial = instrucciones + adjuntos + resumen + conversacion;
  const apagado = !(f.umbralResumen > 0);
  const nombres = f.tools.map((t) => sliceSafe(t.name, 60));
  return {
    titulo: sliceSafe(f.titulo.trim() || 'conversación', 60),
    estado: f.activo ? 'respondiendo' : 'en espera',
    modelo: sliceSafe(f.modelo, 80),
    partes,
    total,
    ventana,
    porcentaje: ventana ? Math.min(100, Math.round((total / ventana) * 100)) : 0,
    historial,
    umbralResumen: apagado ? 0 : f.umbralResumen,
    faltanParaResumen: apagado ? null : Math.max(0, f.umbralResumen - historial),
    resumenApagado: apagado,
    resumenes: f.resumenes,
    ultimoResumen: ultimo === null ? null : new Date(ultimo).toISOString(),
    sinVerificar,
    herramientas: nombres.slice(0, MAX_NOMBRES_HERRAMIENTAS),
    herramientasRecortadas: Math.max(0, nombres.length - MAX_NOMBRES_HERRAMIENTAS),
  };
}

/**
 * Pura: la respuesta de /api/contexto. Primero los hilos que están respondiendo,
 * luego los que más ocupan; como mucho MAX_HILOS. Los hilos de otros chats se cuentan.
 */
export function panelContexto(fuentes: readonly ContextoFuente[], otros = 0): PanelContexto {
  const hilos = fuentes
    .map(contextoDeHilo)
    .sort(
      (a, b) =>
        Number(b.estado === 'respondiendo') - Number(a.estado === 'respondiendo') ||
        b.total - a.total,
    );
  return {
    hilos: hilos.slice(0, MAX_HILOS),
    otros: otros + Math.max(0, hilos.length - MAX_HILOS),
    aprox: true,
    nota: NOTA,
  };
}

/** Lo que el panel lee de un hilo del daemon (estructural, para poder probarlo con falsos). */
export interface HiloDaemon {
  chatKey: string;
  name: string;
  label: string;
  active: boolean;
  agent: {
    readonly modelId: string;
    readonly compaction: { triggerTokens: number };
    readonly compactions: number;
    readonly agent: {
      state: {
        tools?: readonly { name: string; description?: string; parameters?: unknown }[];
        messages: readonly AgentMessage[];
        model?: { contextWindow?: number };
      };
    };
  };
}

/**
 * /api/contexto desde el mapa de hilos del daemon. Con dueño configurado solo se
 * detallan sus hilos privados (`telegram:dm:<dueño>`); los de otros chats se cuentan.
 * El resumen automático cuenta como apagado con PA_COMPACT_TOKENS=0 (como en agent.ts).
 */
export function panelContextoDeHilos(
  hilos: Iterable<HiloDaemon>,
  ownerId: string | number | undefined,
  ventanaPorDefecto: number,
  env: NodeJS.ProcessEnv = process.env,
): PanelContexto {
  const resumenActivo = compactTokensFromEnv(env.PA_COMPACT_TOKENS) > 0;
  const propio = ownerId === undefined ? null : `telegram:dm:${String(ownerId)}`;
  const fuentes: ContextoFuente[] = [];
  let otros = 0;
  for (const h of hilos) {
    if (propio !== null && h.chatKey !== propio) {
      otros++;
      continue;
    }
    const state = h.agent.agent.state;
    fuentes.push({
      titulo: h.label || h.name,
      activo: h.active,
      modelo: h.agent.modelId,
      tools: Array.isArray(state.tools) ? state.tools : [],
      messages: Array.isArray(state.messages) ? state.messages : [],
      ventana: state.model?.contextWindow ?? ventanaPorDefecto,
      umbralResumen: resumenActivo ? h.agent.compaction.triggerTokens : 0,
      resumenes: h.agent.compactions,
    });
  }
  return panelContexto(fuentes, otros);
}
