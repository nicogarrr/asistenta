/**
 * Lo que ve el dueño cuando una respuesta del modelo falla.
 *
 * Antes el chat respondía «Fallo: fetch failed» a un simple «Hola»: el texto
 * crudo del error, en inglés y sin pista de qué hacer. Aquí se traduce a una
 * frase en español con la causa probable (sin internet, servicio caído o
 * saturado, clave mala) y el texto crudo se queda solo en el log.
 */

/** Sin internet o el nombre del servicio no se resuelve (DNS). */
const NO_INTERNET = [/ENOTFOUND/, /EAI_AGAIN/, /ENETUNREACH/, /EHOSTUNREACH/, /ENETDOWN/];
/** El servicio no contesta: conexión rechazada, cortada o sin respuesta. */
const UNREACHABLE = [
  /fetch failed/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /UND_ERR/,
  /socket hang up/i,
  /other side closed/i,
  /network ?error/i,
  /timed? ?out/i,
];
const BAD_KEY = [/invalid api key/i, /unauthori[sz]ed/i, /\b401\b/, /\b403\b/, /forbidden/i];
const NO_FUNDS = [/insufficient funds/i, /\b402\b/];
const RATE_LIMIT = [/\b429\b/, /rate limit/i, /quota/i, /freed?tiererror/i];
const PROVIDER_DOWN = [/\b5\d\d\b/, /overloaded/i, /unavailable/i, /bad gateway/i];
const TOO_LONG = [
  /context length|too many tokens|maximum context|context window|prompt is too long/i,
];
const ABORTED = [/\babort(ed)?\b/i];

const any = (patterns: RegExp[], text: string): boolean => patterns.some((p) => p.test(text));

const RETRY_HINT = 'Prueba en un momento.';
const TOO_LONG_TEXT = 'La conversación se ha hecho demasiado larga para el modelo.';
const INTERNAL_TEXT = 'No he podido terminar la respuesta por un fallo interno.';

/**
 * Frase para el dueño a partir del error crudo del modelo. Nunca devuelve el
 * texto del error: solo la causa probable y qué hacer. Las razones del guardia
 * («Te detuve porque…») ya están escritas para el dueño y pasan tal cual.
 */
export function friendlyModelError(raw: string): string {
  const error = raw.trim();
  if (/^Te detuve\b/.test(error)) return error;
  // La clave mala va antes que la red: un 401 nunca se arregla esperando.
  if (any(BAD_KEY, error)) {
    return 'No puedo hablar con el modelo: la clave no vale o ha caducado. Revísala con «pa doctor».';
  }
  if (any(NO_FUNDS, error)) {
    return 'No puedo hablar con el modelo: el proveedor dice que no hay saldo en la cuenta.';
  }
  if (any(TOO_LONG, error)) {
    return TOO_LONG_TEXT;
  }
  if (any(NO_INTERNET, error)) {
    return `No puedo hablar con el modelo ahora mismo: parece que este PC no tiene internet. ${RETRY_HINT}`;
  }
  if (any(RATE_LIMIT, error)) {
    return 'El modelo está saturado o se ha llegado al límite de uso por ahora. Prueba en unos minutos.';
  }
  if (any(PROVIDER_DOWN, error)) {
    return `El servicio del modelo no responde bien ahora mismo (caído o saturado). ${RETRY_HINT}`;
  }
  if (any(UNREACHABLE, error)) {
    return `No puedo hablar con el modelo ahora mismo (sin conexión o el servicio no responde). ${RETRY_HINT}`;
  }
  if (any(ABORTED, error)) return 'He parado esta respuesta antes de terminarla.';
  return INTERNAL_TEXT;
}

/**
 * Qué arregla un «sí» después del fallo: resumir la conversación si se ha hecho
 * demasiado larga, o repetir el mensaje si falló por dentro. Null si esperar o
 * revisar algo es lo único que sirve.
 */
export function modelErrorFollowUp(raw: string): 'compactar' | 'reintentar' | null {
  const text = friendlyModelError(raw);
  if (text === TOO_LONG_TEXT) return 'compactar';
  if (text === INTERNAL_TEXT) return 'reintentar';
  return null;
}

/** La pregunta que sigue al fallo en el chat; la respuesta «sí» lanza el comando. */
export const MODEL_ERROR_QUESTION = {
  compactar: '¿La resumo para poder seguir? Dime «sí» y luego vuelve a pedírmelo.',
  reintentar: '¿Lo intento otra vez? Dime «sí».',
} as const;

/** Texto final de un turno de chat: la respuesta, o el fallo dicho en claro. */
export function chatReplyText(result: { text: string; error: string | null }): string {
  return result.text.trim() || (result.error ? friendlyModelError(result.error) : 'Sin respuesta.');
}
