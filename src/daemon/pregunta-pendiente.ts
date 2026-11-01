/**
 * Una pregunta corta que el asistente acaba de hacer en un chat («¿Qué página quieres
 * que vigile?») y cuya respuesta en texto normal completa el comando, sin que Nico
 * tenga que volver a escribirlo. Nico (1 nov): «más natural, como estamos hablando
 * nosotros». Solo una por chat, de un uso, y caduca a los 10 minutos; un comando nuevo
 * la anula. Si la respuesta no encaja (varias líneas, muy larga, sin enlace cuando
 * hacía falta uno, o «déjalo») no se usa y el mensaje sigue su camino normal.
 */
import { foldAccents } from '../text.js';

export const PREGUNTA_TTL_MS = 10 * 60_000;

/** «sí» dicho de cualquier forma corta, para las preguntas que esperan un sí. */
export const SI_RESPUESTA = /^(?:s[ií]|vale|venga|ok|okay|claro|dale|hazlo|porfa|por favor)[.!]*$/i;

/**
 * La respuesta a «¿Cómo llamo a la rutina?» convertida en nombre: «Pedir cita» →
 * «pedir-cita». Hasta cuatro palabras; una frase larga no es un nombre.
 */
export function learnNameAnswer(text: string): string | null {
  const words = foldAccents(text)
    .replace(/[«»"'.!?¡¿]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 4) return null;
  const name = words.join('-');
  if (name === 'end' || !/^[a-z0-9][a-z0-9/_-]{0,39}$/.test(name)) return null;
  return name;
}

export interface RespuestaComando {
  name: string;
  args: string;
}

export interface PreguntaOpts {
  prefix?: string;
  needsUrl?: boolean;
  accepts?: (text: string) => boolean;
  answer?: (text: string) => string | null;
}

interface Pendiente {
  command: string;
  prefix: string;
  needsUrl: boolean;
  accepts?: (text: string) => boolean;
  /** Convierte la respuesta en los argumentos exactos del comando, o null si no encaja. */
  answer?: (text: string) => string | null;
  at: number;
}

const CANCELA = /^(?:nada|no|d[eé]jalo|olv[ií]dalo|da igual|cancela(?:r)?|ninguno|ninguna)[.!]*$/i;

export class PreguntasPendientes {
  private readonly byChat = new Map<string, Pendiente>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Recuerda que en `key` se acaba de preguntar por los datos de /`command`. */
  ask(key: string, command: string, opts: PreguntaOpts = {}): void {
    this.byChat.set(key, {
      command,
      prefix: opts.prefix ?? '',
      needsUrl: opts.needsUrl ?? false,
      accepts: opts.accepts,
      answer: opts.answer,
      at: this.now(),
    });
  }

  clear(key: string): void {
    this.byChat.delete(key);
  }

  /** La respuesta convertida en comando, o null (y la pregunta se olvida igual). */
  consume(key: string, text: string): RespuestaComando | null {
    const p = this.byChat.get(key);
    if (!p) return null;
    this.byChat.delete(key);
    if (this.now() - p.at > PREGUNTA_TTL_MS) return null;
    const t = text.trim();
    if (!t || t.startsWith('/') || t.length > 300 || t.includes('\n') || CANCELA.test(t)) {
      return null;
    }
    if (p.needsUrl && !/https?:\/\/\S+/i.test(t)) return null;
    if (p.accepts && !p.accepts(t)) return null;
    if (p.answer) {
      const args = p.answer(t);
      return args === null ? null : { name: p.command, args };
    }
    return { name: p.command, args: `${p.prefix}${t}` };
  }
}
