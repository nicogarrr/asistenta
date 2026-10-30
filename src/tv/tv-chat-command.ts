/**
 * `/tv <orden>` en Telegram: una orden simple para la tele SIN pasar por el
 * modelo (0 tokens, al momento). Usa el mismo parser que action=command
 * (src/tv/natural.ts) y la misma tool, por la misma cola de la tele.
 *
 * - Solo el dueño, en su chat privado (la orden la da el, no el agente).
 * - Si no se entiende, NO se reenvia al modelo: se dice y se dan ejemplos.
 */

import { describeTvIntent, parseTvCommand, tvIntentNotice, tvOrderHasTime } from './natural.js';

export const TV_CHAT_EXAMPLES =
  '/tv apaga la tele · /tv abre Netflix · /tv volumen a 15 · /tv silencio · /tv modo cine · /tv estado';

export const TV_CHAT_USAGE = `Uso: /tv <orden>. Ejemplos: ${TV_CHAT_EXAMPLES}`;

export const TV_CHAT_MAX_LEN = 200;

export interface TvChatCommandDeps {
  /** Dueño verificado en su chat privado. */
  isOwner: boolean;
  /** Ejecuta la orden con la tool tv (action=command) y devuelve su texto. */
  run: (text: string) => Promise<string>;
}

export async function tvChatCommand(args: string, deps: TvChatCommandDeps): Promise<string> {
  const text = args.trim();
  if (!text) return TV_CHAT_USAGE;
  if (!deps.isOwner) return 'Solo el dueño, en su chat privado, puede mandar órdenes a la tele.';
  if (text.length > TV_CHAT_MAX_LEN) {
    return `La orden es demasiado larga para /tv (máx. ${TV_CHAT_MAX_LEN} caracteres). Pídemelo sin /tv.`;
  }
  const intent = parseTvCommand(text);
  if (!intent && tvOrderHasTime(text)) {
    return `«${text.slice(0, 80)}» lleva hora o condición y /tv solo hace cosas al momento: no he tocado la tele. Pídemelo sin /tv.`;
  }
  if (!intent) {
    return `No he entendido «${text.slice(0, 80)}» como orden para la tele. Ejemplos: ${TV_CHAT_EXAMPLES}. Para algo más complejo, pídemelo sin /tv.`;
  }
  try {
    const out = (await deps.run(text)).trim();
    if (!out) return `Hecho: ${describeTvIntent(intent)}.`;
    const notice = tvIntentNotice(intent);
    return notice ? `${out}\n${notice}` : out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `No he podido ${describeTvIntent(intent)}: ${msg}`;
  }
}

/**
 * Mando en botones bajo `/tv` (sin argumentos). Cada botón es una orden fija
 * que pasa por tvChatCommand: mismo parser, misma cola, misma comprobación de
 * dueño en privado. El callback lleva solo el id (nunca texto libre).
 */
export const TV_CALLBACK_PREFIX = 'tv:';

export const TV_BUTTONS: ReadonlyArray<{
  id: string;
  label: string;
  order: string;
  /** Vol ± se pueden pulsar seguido a propósito (subir 2 de golpe): no se filtran. */
  repeatable?: boolean;
}> = [
  { id: 'on', label: '🔌 Encender', order: 'enciende la tele' },
  { id: 'off', label: '⏻ Apagar', order: 'apaga la tele' },
  { id: 'vdown', label: '🔉 Vol −', order: 'baja el volumen', repeatable: true },
  { id: 'vup', label: '🔊 Vol +', order: 'sube el volumen', repeatable: true },
  { id: 'mute', label: '🔇 Silencio', order: 'silencio' },
  { id: 'netflix', label: '🎬 Netflix', order: 'abre netflix' },
  // Pausa/Play van por Glasshouse (la app de la tele rooteada); sin él, el aviso
  // lo dice y no se toca nada. Estado solo lee (SSAP).
  { id: 'pause', label: '⏸ Pausa', order: 'pausa' },
  { id: 'play', label: '▶️ Play', order: 'play' },
  { id: 'status', label: 'ℹ️ Estado', order: 'que esta viendo' },
  // Atrás se pulsa seguido a propósito (volver dos pantallas): no se filtra.
  { id: 'back', label: '⬅️ Atrás', order: 'vuelve atras', repeatable: true },
  // Fila de modos de imagen (SSAP picture), siempre al final y en filas de dos.
  { id: 'pic_std', label: '🖼 Estándar', order: 'pon la imagen en estandar' },
  { id: 'pic_cine', label: '🎞 Cine', order: 'pon la imagen en cine' },
  { id: 'pic_juego', label: '🎮 Juego', order: 'pon la imagen en juego' },
  { id: 'pic_dep', label: '⚽ Deportes', order: 'pon la imagen en deportes' },
  { id: 'pic_viva', label: '🌈 Viva', order: 'pon la imagen en viva' },
  { id: 'pic_eco', label: '🌙 Oscura', order: 'pon la imagen en oscura' },
];

export const TV_BUTTONS_TITLE = 'Mando de la tele (o escribe /tv <orden>):';

export function tvButtons(): Array<{ label: string; action: string }> {
  return TV_BUTTONS.map((b) => ({ label: b.label, action: `${TV_CALLBACK_PREFIX}${b.id}` }));
}

/** Ventana en la que la MISMA pulsación (mismo chat, mismo botón) se ignora. */
export const TV_REPEAT_WINDOW_MS = 1000;

export const TV_REPEAT_IGNORED = 'Ya lo he mandado; espera un segundo para repetir.';

/**
 * Filtro de doble pulsación: un dedo que toca dos veces «Silencio» o «Apagar»
 * (o Telegram que entrega dos veces el mismo toque) no debe mandar dos órdenes
 * (silencio + quitar silencio). Recuerda la última pulsación por chat+botón.
 */
export interface TvPressGuard {
  /** true si `key` ya se pulsó hace menos de la ventana (y entonces NO cuenta como nueva). */
  isRepeat(key: string): boolean;
}

export function createTvPressGuard(
  windowMs = TV_REPEAT_WINDOW_MS,
  now: () => number = Date.now,
): TvPressGuard {
  const last = new Map<string, number>();
  return {
    isRepeat(key: string): boolean {
      const t = now();
      for (const [k, at] of last) if (t - at >= windowMs) last.delete(k);
      const prev = last.get(key);
      if (prev !== undefined && t - prev < windowMs) return true;
      last.set(key, t);
      return false;
    },
  };
}

export interface TvButtonDeps extends TvChatCommandDeps {
  /** Filtro de doble pulsación; sin él, cada pulsación cuenta (comportamiento anterior). */
  guard?: TvPressGuard;
  /** Chat de la pulsación (para que el filtro sea por chat). */
  chatId?: string;
}

/** Pulsación de un botón del mando: `data` es el callback completo («tv:<id>»). */
export async function tvButtonCommand(data: string, deps: TvButtonDeps): Promise<string> {
  if (!deps.isOwner) return 'Solo el dueño, en su chat privado, puede mandar órdenes a la tele.';
  const id = data.startsWith(TV_CALLBACK_PREFIX) ? data.slice(TV_CALLBACK_PREFIX.length) : '';
  const button = TV_BUTTONS.find((b) => b.id === id);
  if (!button) return 'Ese botón ya no existe. Escribe /tv para sacar el mando otra vez.';
  if (!button.repeatable && deps.guard?.isRepeat(`${deps.chatId ?? ''}:${button.id}`)) {
    return TV_REPEAT_IGNORED;
  }
  return tvChatCommand(button.order, deps);
}
