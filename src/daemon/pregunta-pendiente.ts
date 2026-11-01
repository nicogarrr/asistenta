/**
 * Una pregunta corta que el asistente acaba de hacer en un chat («¿Qué página quieres
 * que vigile?») y cuya respuesta en texto normal completa el comando, sin que Nico
 * tenga que volver a escribirlo. Nico (1 nov): «más natural, como estamos hablando
 * nosotros». Solo una por chat, de un uso, y caduca a los 10 minutos; un comando nuevo
 * la anula. Si la respuesta no encaja (varias líneas, muy larga, sin enlace cuando
 * hacía falta uno, o «déjalo») no se usa y el mensaje sigue su camino normal.
 */
export const PREGUNTA_TTL_MS = 10 * 60_000;

export interface RespuestaComando {
  name: string;
  args: string;
}

interface Pendiente {
  command: string;
  prefix: string;
  needsUrl: boolean;
  accepts?: (text: string) => boolean;
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
  ask(
    key: string,
    command: string,
    opts: { prefix?: string; needsUrl?: boolean; accepts?: (text: string) => boolean } = {},
  ): void {
    this.byChat.set(key, {
      command,
      prefix: opts.prefix ?? '',
      needsUrl: opts.needsUrl ?? false,
      accepts: opts.accepts,
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
    return { name: p.command, args: `${p.prefix}${t}` };
  }
}
