import { randomBytes } from 'node:crypto';
import { sliceSafe } from '../text.js';

/**
 * Lo del canal de Telegram que no necesita grammY: botones de orden, «📖 Ver todo» con su
 * copia completa y el límite de descarga. Vive aparte para que cli.ts lo use sin cargar
 * grammY (~35 módulos con node-fetch) en cada arranque de `pa`; telegram.ts lo reexporta.
 */

/** Entrada de la caché de respuestas completas, con su instante de caducidad. */
interface CachedReply {
  text: string;
  expires: number;
}

/**
 * Una respuesta completa se guarda para "Dime más". Diez minutos cubren la lectura
 * normal de un mensaje y 24 entradas acotan la memoria por proceso sin expulsar los
 * hilos recientes.
 */
const FULL_REPLY_TTL_MS = 10 * 60_000;
const FULL_REPLY_MAX_ENTRIES = 24;

/** Prefijo de los botones que equivalen a teclear una orden (ver commandButton). */
export const COMMAND_CALLBACK_PREFIX = 'cmd:';
/** Aviso de un botón de orden que ya no se reconoce. */
export const STALE_BUTTON = 'Este botón ya no sirve. Escribe la orden a mano.';
/**
 * Órdenes que un botón puede lanzar, con las subórdenes permitidas ('' = sin
 * suborden). Lista cerrada: un callback_data inventado no puede lanzar otra orden,
 * y cada una pasa por el mismo camino (y permisos) que si se tecleara. Solo
 * acciones que se deshacen con otro toque o que el usuario ve en su lista: borrar
 * una rutina sigue pidiendo escribirlo.
 */
const BUTTON_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['dejar_de_vigilar', new Set([''])],
  // «👀 Vigilar» de /compara: el arg es un id corto en memoria, nunca el enlace.
  // «🔕 Silenciar 1 día» en un aviso de precio: calla la página 24 h, no borra nada.
  ['vigila', new Set(['enlace', 'silenciar', 'avisar'])],
  // Solo lectura: enseña la ficha de precio de una página vigilada.
  // …y «🔕 Silenciar 1 día» / «🔔 Avisar otra vez» de un aviso del vigilante de precios.
  ['precio', new Set(['', 'silenciar', 'avisar'])],
  // Botones de un recordatorio que acaba de avisar: no borran nada (+1h crea otro).
  ['recordatorios', new Set(['hecho', 'pospone', 'manana'])],
  ['cron', new Set(['pausa', 'reanudar'])],
  // Ficha de un candidato de la auto-mejora: «📄 Ver parche» solo lee; «✅ Aplicar» es la
  // aprobación del dueño (un commit local que se deshace con git revert); «🗑 Descartar»
  // no toca la copia. El daemon exige dueño en privado para aplicar y descartar.
  ['evolucion', new Set(['parche', 'aplicar', 'descartar'])],
  // «🔄 Reintentar» bajo una respuesta que falló: repite ESE mensaje (arg = su id), como
  // /reintentar; si ya hubo otro después, no repite nada.
  ['reintentar', new Set([''])],
  // «⏹ Pararlo» del aviso de cola (daemon/busy-note.ts): arg = ficha de ESA tarea; si ya
  // terminó no para nada, y nunca vacía la cola (eso es /stop a secas).
  ['stop', new Set([''])],
  // «⏸️ Parar todo en el PC» (pausa-pc.ts): el primer toque solo PREGUNTA; «confirmar»
  // lleva el código de ESE aviso (caduca a los 5 min) y el daemon exige dueño en privado.
  ['pausa_pc', new Set(['', 'confirmar', 'cancelar'])],
  // «▶️ Levantar todo» del modo pausa: vuelve a arrancar lo configurado.
  ['levantar', new Set([''])],
]);
const BUTTON_ARG = /^[A-Za-z0-9_-]{1,40}$/;

function allowed(command: string, sub: string): boolean {
  return BUTTON_COMMANDS.get(command)?.has(sub) ?? false;
}

/**
 * Botón en línea que equivale a escribir `/<orden> [suborden] <arg>`. Devuelve
 * undefined si la orden (o suborden) no está en la lista, si el argumento no es un
 * nombre o id simple, o si no cabe en los 64 bytes de callback_data de Telegram.
 */
export function commandButton(
  label: string,
  command: string,
  arg: string,
  sub = '',
): { label: string; action: string } | undefined {
  const action = `${COMMAND_CALLBACK_PREFIX}${command} ${sub ? `${sub} ` : ''}${arg}`;
  if (!allowed(command, sub) || !BUTTON_ARG.test(arg) || action.length > 64) return undefined;
  const short = label.length > 40 ? `${sliceSafe(label, 39)}…` : label;
  return { label: short, action };
}

/** El texto de orden (`/cron pausa resumen`) de un botón, o undefined si no vale. */
export function commandFromCallback(data: string): string | undefined {
  if (!data.startsWith(COMMAND_CALLBACK_PREFIX)) return undefined;
  const m = /^([a-z_]{1,32}) (?:([a-z]{1,16}) )?(\S+)$/.exec(
    data.slice(COMMAND_CALLBACK_PREFIX.length),
  );
  const command = m?.[1];
  const sub = m?.[2] ?? '';
  const arg = m?.[3];
  if (!command || !arg || !allowed(command, sub) || !BUTTON_ARG.test(arg)) return undefined;
  return `/${command} ${sub ? `${sub} ` : ''}${arg}`;
}

/** Prefijo del callback de «📖 Ver todo»; nunca empieza como approve:/deny:. */
export const MORE_CALLBACK_PREFIX = 'more:';

export const MORE_BUTTON_LABEL = '📖 Ver todo';
export const MORE_GONE = 'Ya no tengo el texto completo. Pídemelo otra vez.';

interface MoreToken {
  threadKey: string;
  chatId: string;
  threadId?: string;
  expires: number;
  /** Quita el botón del mensaje recortado; lo pone el canal al enviarlo. */
  retire?: () => void;
}

/**
 * La copia completa de `threadKey` se ha usado («más» escrito) o sustituido (otra
 * respuesta): sus botones «📖 Ver todo» ya solo dirían «Ya no tengo el texto», así
 * que se retiran del chat y sus fichas se invalidan.
 */
export function retireMoreButtons(threadKey: string): void {
  for (const [token, entry] of moreTokens) {
    if (entry.threadKey !== threadKey) continue;
    moreTokens.delete(token);
    entry.retire?.();
  }
}

/** Liga las fichas «more:» de `buttons` al mensaje que las lleva (para poder retirarlas). */
export function bindMoreButtons(
  buttons: ReadonlyArray<{ action: string }> | undefined,
  chatId: string,
  retire: () => void,
): void {
  for (const button of buttons ?? []) {
    if (!button.action.startsWith(MORE_CALLBACK_PREFIX)) continue;
    const entry = moreTokens.get(button.action.slice(MORE_CALLBACK_PREFIX.length));
    if (entry && entry.chatId === chatId) entry.retire = retire;
  }
}

/** Fichas cortas de botón → hilo: la clave del hilo no cabe (ni debe ir) en los 64 bytes del callback. */
const moreTokens = new Map<string, MoreToken>();

/**
 * Botón «📖 Ver todo» para una respuesta recortada de `threadKey`. Caduca con la
 * copia completa (mismo TTL y mismo tope) y solo vale en el chat donde se envió.
 */
export function moreButton(
  threadKey: string,
  chatId: string,
  threadId?: string,
): { label: string; action: string } {
  const now = Date.now();
  for (const [key, entry] of moreTokens) {
    if (entry.expires <= now) moreTokens.delete(key);
  }
  const token = randomBytes(6).toString('base64url');
  moreTokens.set(token, { threadKey, chatId, threadId, expires: now + FULL_REPLY_TTL_MS });
  while (moreTokens.size > FULL_REPLY_MAX_ENTRIES) {
    const oldest = moreTokens.keys().next();
    if (oldest.done) break;
    moreTokens.delete(oldest.value);
  }
  return { label: MORE_BUTTON_LABEL, action: `${MORE_CALLBACK_PREFIX}${token}` };
}

/** Retira la ficha (un solo uso); null si no existe o caducó. */
export function takeMoreToken(token: string): MoreToken | null {
  const entry = moreTokens.get(token);
  if (!entry) return null;
  moreTokens.delete(token);
  return entry.expires > Date.now() ? entry : null;
}

/** Respuestas completas recientes, para servir "Dime más" sin volver a ejecutar. */
const fullReplies = new Map<string, CachedReply>();

/**
 * Guarda la respuesta completa de un hilo.
 *
 * El mensaje de Telegram puede ir recortado, así que el CLI conserva aquí el texto
 * entero y lo sirve cuando el usuario pide el detalle. Se purgan las entradas
 * caducadas y se expulsa la más antigua al superar el tope; 24 respuestas bastan
 * para los hilos que un humano puede estar leyendo a la vez.
 */
export function cacheFullReply(threadKey: string, text: string): void {
  const now = Date.now();
  for (const [key, entry] of fullReplies) {
    if (entry.expires <= now) fullReplies.delete(key);
  }
  // Reinsertar refresca el orden de expulsión: la entrada vuelve a ser la más nueva.
  // La copia anterior se pierde: su botón ya no sirve.
  if (fullReplies.delete(threadKey)) retireMoreButtons(threadKey);
  fullReplies.set(threadKey, { text, expires: now + FULL_REPLY_TTL_MS });
  while (fullReplies.size > FULL_REPLY_MAX_ENTRIES) {
    const oldest = fullReplies.keys().next();
    if (oldest.done) break;
    fullReplies.delete(oldest.value);
  }
}

/**
 * Retira y devuelve la respuesta completa de un hilo, o null si no existe o caducó.
 *
 * Es destructivo a propósito: "Dime más" consume la respuesta una vez, igual que el
 * mensaje recortado que la ofrecía. Una segunda petición no puede repetir un texto
 * que ya se mostró por error.
 */
export function takeFullReply(threadKey: string): string | null {
  const entry = fullReplies.get(threadKey);
  if (!entry) return null;
  fullReplies.delete(threadKey);
  retireMoreButtons(threadKey);
  return entry.expires > Date.now() ? entry.text : null;
}

/** Peticiones que significan "sigue con el resto", ya sin acentos ni mayúsculas. */
const MORE_REQUEST = /\b(?:mas|detalles?|sigue|continua|el resto)\b/;

/**
 * Palabras que caben en una petición de «el resto» y nada más. Si el mensaje trae
 * otra palabra («sigue BUSCANDO vuelos», «pon la música MÁS alta»), es un encargo
 * nuevo y tiene que llegar al agente, no reenviar la respuesta anterior.
 */
const MORE_FILLER = new Set([
  'mas',
  'detalle',
  'detalles',
  'sigue',
  'continua',
  'el',
  'resto',
  'dime',
  'dame',
  'cuentame',
  'quiero',
  'por',
  'favor',
  'porfa',
  'y',
  'venga',
  'vale',
  'ok',
  'todo',
  'lo',
  'la',
  'respuesta',
  'completa',
  'entera',
  'ver',
  'manda',
  'mandame',
  'pasame',
]);

/**
 * ¿El mensaje pide el resto de una respuesta recortada?
 *
 * Se normaliza a minúsculas y sin diacríticos para que "más", "MAS" y "mas" sean la
 * misma petición. Las fronteras de palabra evitan que "demasiado" o "detallado"
 * disparen la caché por accidente. Y el mensaje entero tiene que ser la petición
 * (como mucho 6 palabras, todas de MORE_FILLER): antes bastaba con que apareciera
 * «más» o «sigue» en cualquier frase, y «sigue buscando vuelos» reenviaba la
 * respuesta anterior en vez de hacer el encargo.
 */
export function isMoreRequest(text: string): boolean {
  const plain = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  if (!MORE_REQUEST.test(plain)) return false;
  const words = plain.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length <= 6 && words.every((w) => MORE_FILLER.has(w));
}

/** Lo más que un bot puede descargar de Telegram (getFile de la Bot API); lo mismo que corta downloadFile. */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20_000_000;

/**
 * Frase para un archivo que Telegram declara por encima del límite de descarga de los
 * bots: antes solo se decía «Telegram no devolvió el archivo» y no se sabía por qué.
 * Sin tamaño, o por debajo del límite, devuelve undefined.
 */
export function tooBigForBotDownload(sizeBytes: number | undefined): string | undefined {
  if (!sizeBytes || sizeBytes <= TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) return undefined;
  const mb = Math.ceil(sizeBytes / 1_000_000);
  return `Pesa ${mb} MB y pasa de 20 MB, el límite de descarga de los bots de Telegram.`;
}
