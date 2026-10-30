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
