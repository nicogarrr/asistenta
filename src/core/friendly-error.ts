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
 * ¿Falló por la red o porque el servicio del modelo está caído o saturado? Son
 * los fallos que se arreglan solos esperando (no una clave mala, sin saldo, una
 * conversación demasiado larga o un fallo interno): los que merece la pena
 * reintentar sin que el dueño vuelva a escribir.
 */
export function isOutageError(raw: string | null | undefined): boolean {
  const error = (raw ?? '').trim();
  if (!error || /^Te detuve\b/.test(error)) return false;
  if (any(BAD_KEY, error) || any(NO_FUNDS, error) || any(TOO_LONG, error)) return false;
  return (
    any(NO_INTERNET, error) ||
    any(RATE_LIMIT, error) ||
    any(PROVIDER_DOWN, error) ||
    any(UNREACHABLE, error)
  );
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

/**
 * La «tarjeta de error» de Hermes en Telegram: si el fallo BLOQUEA (no se arregla esperando:
 * clave mala, sin saldo, conversación demasiado larga) o es PASAJERO (red, servicio caído o
 * saturado, un fallo interno que suele salir a la segunda), y la UNA acción que lo arregla,
 * como botón bajo el mensaje. Antes todo fallo llevaba «🔄 Reintentar», también los que
 * volverían a fallar igual (una conversación demasiado larga o una clave caducada).
 */
export type ModelErrorKind = 'bloqueante' | 'pasajero';
export type ModelErrorAction = 'reintentar' | 'compactar' | 'estado';

export interface ModelErrorCard {
  kind: ModelErrorKind;
  action: ModelErrorAction;
}

/** null si no es un fallo que enseñar como tarjeta (el guardia te detuvo, o lo paraste tú). */
export function modelErrorCard(raw: string | null | undefined): ModelErrorCard | null {
  const error = (raw ?? '').trim();
  if (!error || /^Te detuve\b/.test(error)) return null;
  if (any(BAD_KEY, error) || any(NO_FUNDS, error)) return { kind: 'bloqueante', action: 'estado' };
  if (any(TOO_LONG, error)) return { kind: 'bloqueante', action: 'compactar' };
  if (isOutageError(error)) return { kind: 'pasajero', action: 'reintentar' };
  if (any(ABORTED, error)) return null;
  return { kind: 'pasajero', action: 'reintentar' };
}

/** El texto del botón de cada acción. */
export const MODEL_ERROR_ACTION_LABEL: Record<ModelErrorAction, string> = {
  reintentar: '🔄 Reintentar',
  compactar: '🗜️ Resumir y reintentar',
  estado: '🩺 Ver el estado',
};

/**
 * La marca de la tarjeta de error que va delante del texto de un turno fallido: «⛔ » si
 * bloquea (esperar no lo arregla) o «⚠️ » si es pasajero; '' si hay respuesta, si no hubo
 * error o si no es un fallo que marcar (el guardia, o lo paraste tú).
 */
export function modelErrorMark(result: { text: string; error: string | null }): string {
  if (result.text.trim() || !result.error) return '';
  const card = modelErrorCard(result.error);
  if (!card) return '';
  return card.kind === 'bloqueante' ? '⛔ ' : '⚠️ ';
}
