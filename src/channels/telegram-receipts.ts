import { sliceSafe } from '../text.js';
/**
 * Acuse de recibo de lo que llega con peso: nota de voz, audio, foto o documento.
 *
 * Transcribir o leer un fichero tarda segundos (el primer audio carga el modelo de
 * disco), y durante ese rato el chat solo mostraba «escribiendo…». Ahora sale al
 * momento un mensaje corto que dice qué se está haciendo, citando lo recibido, y se
 * EDITA cuando termina: la nota de voz queda con lo que se entendió (así se ve en
 * seguida si oyó mal), y el acuse de una foto o documento se borra con el resto de
 * notas de progreso al llegar la respuesta.
 *
 * Puro salvo por las dos funciones inyectadas: se prueba sin bot ni red.
 */

export type ReceiptKind = 'voice' | 'audio' | 'photo' | 'document';

/** Lo que mira el acuse de un mensaje entrante (subconjunto de Inbound). */
export interface ReceiptInput {
  audioFileId?: string;
  photoFileId?: string;
  documentFileId?: string;
  documentName?: string;
  documentMimeType?: string;
}

/** Largo máximo de lo transcrito que se enseña en el acuse. */
const HEARD_MAX = 300;

/** Qué clase de acuse merece este mensaje, o null si es solo texto. */
export function receiptKind(inbound: ReceiptInput): ReceiptKind | null {
  if (inbound.audioFileId) return 'voice';
  if (inbound.documentFileId) {
    const mime = inbound.documentMimeType?.toLowerCase() ?? '';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('image/')) return 'photo';
    return 'document';
  }
  if (inbound.photoFileId) return 'photo';
  return null;
}

/** Nombre corto y legible del fichero (sin rutas, con tope). */
function shortName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop()?.trim() ?? '';
  if (!base) return '';
  return base.length > 60 ? `${sliceSafe(base, 57)}…` : base;
}

/** El texto inicial del acuse. */
export function receiptStartText(kind: ReceiptKind, inbound: ReceiptInput = {}): string {
  const name = shortName(inbound.documentName);
  switch (kind) {
    case 'voice':
      return '🎙️ Transcribiendo la nota de voz…';
    case 'audio':
      return name ? `🎧 Transcribiendo «${name}»…` : '🎧 Transcribiendo el audio…';
    case 'photo':
      return name ? `🖼️ Mirando «${name}»…` : '🖼️ Mirando la foto…';
    case 'document':
      return name ? `📄 Leyendo «${name}»…` : '📄 Leyendo el documento…';
  }
}

/** El acuse de una nota de voz, ya transcrita: lo que se entendió, entre comillas. */
export function voiceHeardText(transcript: string): string {
  const flat = transcript.replace(/\s+/g, ' ').trim();
  if (!flat) return '🎙️ No he entendido ninguna palabra.';
  const cut = flat.length > HEARD_MAX ? `${flat.slice(0, HEARD_MAX - 1).trimEnd()}…` : flat;
  return `🎙️ «${cut}»`;
}

/** Texto intermedio de un fichero ya leído, mientras el agente piensa la respuesta. */
export const RECEIPT_READ_TEXT = '✅ Recibido. Pensando la respuesta…';

export interface ReceiptDeps {
  /** Publica el acuse (citando el mensaje recibido) y devuelve su id. */
  send: (text: string) => Promise<string | null>;
  /** Edita el acuse. Debe tragarse sus propios fallos. */
  edit: (messageId: string, text: string) => Promise<void>;
}

/**
 * Un mensaje que se publica una vez y después se EDITA. Nunca rompe el turno: si el
 * envío falla no hay mensaje y las ediciones se omiten. Las llamadas se encadenan,
 * así que un `show` que llega mientras el primer envío sigue en vuelo edita ese
 * mismo mensaje en vez de publicar otro.
 */
export class LiveNote {
  #id: string | null = null;
  #last = '';
  #chain: Promise<void> = Promise.resolve();
  readonly #deps: ReceiptDeps;

  constructor(deps: ReceiptDeps) {
    this.#deps = deps;
  }

  /** Id del mensaje publicado, o null si no se llegó a publicar. */
  get id(): string | null {
    return this.#id;
  }

  /** Publica el texto la primera vez; las siguientes edita el mismo mensaje. */
  show(text: string): Promise<void> {
    this.#chain = this.#chain.then(() => (this.#id ? this.#edit(text) : this.#send(text)));
    return this.#chain;
  }

  /** Solo publica (si aún no hay mensaje). */
  start(text: string): Promise<void> {
    this.#chain = this.#chain.then(() => (this.#id ? undefined : this.#send(text)));
    return this.#chain;
  }

  /** Solo edita (si ya hay mensaje). */
  update(text: string): Promise<void> {
    this.#chain = this.#chain.then(() => (this.#id ? this.#edit(text) : undefined));
    return this.#chain;
  }

  async #send(text: string): Promise<void> {
    try {
      this.#id = await this.#deps.send(text);
      this.#last = text;
    } catch {
      this.#id = null;
    }
  }

  async #edit(text: string): Promise<void> {
    if (!this.#id || text === this.#last) return;
    this.#last = text;
    try {
      await this.#deps.edit(this.#id, text);
    } catch {
      // Un mensaje que no se pudo editar no vale un turno roto.
    }
  }
}

/** Acuse de recibo de un mensaje entrante: un {@link LiveNote} con nombre propio. */
export class InboundReceipt extends LiveNote {}
