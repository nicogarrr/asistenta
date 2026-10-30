/**
 * `/tv <orden>` en Telegram: una orden simple para la tele SIN pasar por el
 * modelo (0 tokens, al momento). Usa el mismo parser que action=command
 * (src/tv/natural.ts) y la misma tool, por la misma cola de la tele.
 *
 * - Solo el dueño, en su chat privado (la orden la da el, no el agente).
 * - Si no se entiende, NO se reenvia al modelo: se dice y se dan ejemplos.
 */

import { describeTvIntent, parseTvCommand } from './natural.js';

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
  if (!intent) {
    return `No he entendido «${text.slice(0, 80)}» como orden para la tele. Ejemplos: ${TV_CHAT_EXAMPLES}. Para algo más complejo, pídemelo sin /tv.`;
  }
  try {
    const out = (await deps.run(text)).trim();
    return out || `Hecho: ${describeTvIntent(intent)}.`;
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

export const TV_BUTTONS: ReadonlyArray<{ id: string; label: string; order: string }> = [
  { id: 'on', label: '🔌 Encender', order: 'enciende la tele' },
  { id: 'off', label: '⏻ Apagar', order: 'apaga la tele' },
  { id: 'vdown', label: '🔉 Vol −', order: 'baja el volumen' },
  { id: 'vup', label: '🔊 Vol +', order: 'sube el volumen' },
  { id: 'mute', label: '🔇 Silencio', order: 'silencio' },
  { id: 'netflix', label: '🎬 Netflix', order: 'abre netflix' },
  // Pausa/Play van por Glasshouse (la app de la tele rooteada); sin él, el aviso
  // lo dice y no se toca nada. Estado solo lee (SSAP).
  { id: 'pause', label: '⏸ Pausa', order: 'pausa' },
  { id: 'play', label: '▶️ Play', order: 'play' },
  { id: 'status', label: 'ℹ️ Estado', order: 'que esta viendo' },
];

export const TV_BUTTONS_TITLE = 'Mando de la tele (o escribe /tv <orden>):';

export function tvButtons(): Array<{ label: string; action: string }> {
  return TV_BUTTONS.map((b) => ({ label: b.label, action: `${TV_CALLBACK_PREFIX}${b.id}` }));
}

/** Pulsación de un botón del mando: `data` es el callback completo («tv:<id>»). */
export async function tvButtonCommand(data: string, deps: TvChatCommandDeps): Promise<string> {
  if (!deps.isOwner) return 'Solo el dueño, en su chat privado, puede mandar órdenes a la tele.';
  const id = data.startsWith(TV_CALLBACK_PREFIX) ? data.slice(TV_CALLBACK_PREFIX.length) : '';
  const button = TV_BUTTONS.find((b) => b.id === id);
  if (!button) return 'Ese botón ya no existe. Escribe /tv para sacar el mando otra vez.';
  return tvChatCommand(button.order, deps);
}
